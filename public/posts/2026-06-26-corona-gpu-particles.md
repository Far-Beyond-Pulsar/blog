---
title: "Corona: Building a GPU-Native Particle System"
date: "2026-06-26"
author: "Tristan Poland"
tags: ["rust", "helio", "graphics", "optimization", "pulsar"]
description: "A full technical walkthrough of Corona — Helio's GPU-native particle system. How we went from invisible particles and flickering garbage to a million stable, depth-sorted, atlas-rendered particles using prefix sums, bitonic sort, and a lot of debugging."
thumbnail: /post_thumb/corona.png
---

## Why Build Another Particle System

Every production game engine has one. Particle systems are so common that "just use a library" is usually the correct answer. We didn't use a library for the same reason we didn't use an existing renderer: the assumptions baked into existing systems eventually become constraints you didn't agree to.

The specific constraints we wanted to avoid were CPU-side. Most particle systems maintain a live particle list on the CPU: simulate, cull dead particles, sort, upload. For tens of thousands of particles that's fine. For hundreds of thousands it's a meaningful frame-budget line item. For a million it's off the table without heroic threading. The GPU can do all of that work — simulation, aging, compaction, sorting — and it can do it on a million particles in the time it takes the CPU to touch a few thousand. But taking advantage of that requires owning the full pipeline from particle state to draw call, which means building it ourselves.

Corona is what we built. All particle state lives in GPU buffers. The CPU's role per frame is to upload a 32-byte uniform block, record a fixed sequence of compute passes, and submit draw_indirect calls. No particle position ever crosses the PCIe bus. No alive/dead scan happens on the CPU. The entire system from simulate to render is expressed in WGSL compute and render shaders dispatched through Helio's render graph.

This post is an honest account of how it works, what broke during development, and why several of the design decisions ended up the way they did rather than the way they initially seemed.

---

## Particle State Layout

Each particle is a 64-byte GPU struct. The layout is driven by the constraint that wgpu storage buffers must be 16-byte aligned, so all fields are packed into `vec4<f32>`:

```wgsl
struct Particle {
    pos_and_alive:     vec4<f32>,  // xyz = world position, w = alive (0 or 1)
    velocity:          vec4<f32>,  // xyz = velocity m/s, w = emitter_index
    color:             vec4<f32>,  // rgba, interpolated over lifetime
    size_lifetime_age: vec4<f32>,  // x = billboard size, z = lifetime, w = current age
}
```

The alive flag lives in `pos_and_alive.w` rather than a separate field so the simulate shader can do its early exit with a single 128-bit vector read. On the GPU, minimizing dependent loads matters.

The `velocity.w` field stores the emitter index as a float-encoded integer. This sounds like a hack, but it's the cleanest solution to a real problem: the vertex shader needs to know which emitter spawned a particle to look up its sprite atlas index, but we didn't want to add an emitter index to every particle entry explicitly (which would require padding the struct to maintain 64-byte alignment). Encoding it in the unused `w` component is zero-cost — the field exists regardless.

Emitters are 256 bytes:

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct GpuCoronaEmitter {
    pub transform:          [[f32; 4]; 4],  // column-major world transform
    pub emit_params:        [f32; 4],       // emit_rate, lifetime, lifetime_var, gravity
    pub size_params:        [f32; 4],       // start_size.xy, end_size.xy
    pub start_color:        [f32; 4],
    pub end_color:          [f32; 4],
    pub velocity:           [f32; 4],
    pub velocity_variation: [f32; 4],
    pub extras:             [f32; 4],       // shape_type, radius, pad, active
    pub texture_index:      i32,
    pub particle_offset:    u32,
    pub particle_count:     u32,
    pub spawn_cursor:       u32,
    pub _pad:               [f32; 12],
}
```

`particle_offset` and `particle_count` define each emitter's exclusive sub-range in the global particle buffer. With four emitters, those ranges look like:

```
[0       .. 262143] → fountain   (262,144 slots)
[262144  .. 393215] → nebula     (131,072 slots)
[393216  .. 458751] → fire ring   (65,536 slots)
[458752  .. 589823] → galaxy     (131,072 slots)
```

Non-overlapping ranges are enforced by the CPU in `prepare()` and are the foundational invariant the rest of the system depends on. Every compute shader that needs to identify which emitter owns a particle does a linear scan through the emitter list checking `idx >= particle_offset && idx < particle_offset + particle_count`. It's O(emitter_count) per thread, but with a max of 64 emitters that's 64 comparisons per particle — fast on the GPU.

One constraint we enforce that wasn't obvious at first: every emitter's `particle_count` must be a multiple of the workgroup size (256). This guarantees that block boundaries in the prefix scan never cross emitter boundaries. In `prepare()`:

```rust
let aligned_count = (src_em.particle_count + WG - 1) / WG * WG;
```

For our demo emitters (262144, 131072, 65536, 131072), all powers of two, this is a no-op. But any emitter with an arbitrary particle count would silently produce incorrect prefix sum results without it.

---

## The Compute Pipeline

Nine compute passes run every frame in a fixed linear order. Helio's command encoder records them sequentially; implicit memory barriers between pass boundaries ensure each pass sees the fully committed output of the previous one.

### cs_simulate

The simulate pass runs one thread per particle slot across the full buffer. Dead particles (alive flag < 0.5) return immediately after the branch. Live particles advance position by velocity×dt, apply gravity, age, expire if age ≥ lifetime, and interpolate color and size along a linear gradient between the emitter's start and end values:

```wgsl
@compute @workgroup_size(256)
fn cs_simulate(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if idx >= uniforms.total_particles { return; }

    var p = particles[idx];
    if p.pos_and_alive.w < 0.5 { return; }

    p.size_lifetime_age.w += uniforms.delta_time;
    if p.size_lifetime_age.w >= p.size_lifetime_age.z {
        p.pos_and_alive.w = 0.0;
        particles[idx] = p;
        return;
    }
    // ... position integration, gravity, color/size interpolation
}
```

For 1,048,576 total slots, that's 4,096 workgroups of 256 threads. Dead particles cost one branch and a return. Live particles do a handful of multiplies, adds, and a lerp.

### cs_emit

The emit pass spawns new particles using a ring buffer cursor per emitter. One workgroup per emitter runs sequentially, computing how many particles to spawn this frame as `floor(emit_rate × dt)` and writing that many fresh particles to consecutive cursor positions wrapping around the emitter's slot range.

The emitter index is stored in the new particle's `velocity.w`:

```wgsl
p.velocity = vec4<f32>(vel, f32(eidx));
```

The GPU writes the advanced cursor back to `emitters[eidx].spawn_cursor`. This GPU-side cursor write is the key to particle accumulation — but it creates a subtle problem when the CPU also needs to track the cursor, which we'll get to.

### cs_scan_local, cs_scan_blocks, cs_scatter

These three passes replace what an earlier iteration did with a single pass using global atomics. The problem with the atomic approach: on GPUs with many warps competing for the same counter, contention is measurable and non-deterministic. More importantly, atomics produce a scattered, non-deterministic ordering in compact_buf — alive particles land at whatever slot they raced to claim. That's fine for compaction, but it means depth sorting can't trust the order of the compacted array.

The prefix sum approach eliminates atomics entirely and produces a deterministic scatter position for each alive particle.

**cs_scan_local** (Hillis-Steele inclusive scan per 256-element block):

```wgsl
@compute @workgroup_size(256)
fn cs_scan_local(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_id)  lid: vec3<u32>,
    @builtin(workgroup_id)         wid: vec3<u32>,
) {
    let idx        = gid.x;
    let alive_flag = select(0u, 1u,
        idx < uniforms.total_particles && particles[idx].pos_and_alive.w >= 0.5);

    // Reset sort key to sentinel so dead/stale slots sort to the far end.
    if idx < uniforms.total_particles { sort_key_buf[idx] = -F32_MAX; }

    wg_scratch[lid.x] = alive_flag;
    workgroupBarrier();

    // Hillis-Steele inclusive scan: O(log N) steps, O(N log N) work.
    var step = 1u;
    loop {
        if step >= WG { break; }
        let val = select(0u, wg_scratch[lid.x - step], lid.x >= step);
        workgroupBarrier();
        wg_scratch[lid.x] += val;
        workgroupBarrier();
        step <<= 1u;
    }
    // wg_scratch[lid.x] = inclusive prefix sum.

    if lid.x == WG - 1u { block_sums_buf[wid.x] = wg_scratch[WG - 1u]; }

    let excl = select(wg_scratch[lid.x - 1u], 0u, lid.x == 0u);
    if idx < uniforms.total_particles { prefix_buf[idx] = excl; }
}
```

After this pass, `prefix_buf[i]` = how many alive particles appear before slot `i` within its 256-element block, and `block_sums_buf[b]` = total alive particles in block `b`.

**cs_scan_blocks** scans the block_sums sequentially per emitter to convert per-block totals into cumulative per-block offsets within the emitter's alive range. One workgroup per emitter, workgroup size 1. With at most 1024 blocks per emitter (262144 / 256), this is 1024 sequential additions — fast even single-threaded:

```wgsl
@compute @workgroup_size(1)
fn cs_scan_blocks(@builtin(workgroup_id) wid: vec3<u32>) {
    let eidx = wid.x;
    let em   = emitters[eidx];
    let block_lo = em.particle_offset / WG;
    let block_hi = (em.particle_offset + em.particle_count + WG - 1u) / WG;

    var cumsum = 0u;
    for (var b = block_lo; b < block_hi; b++) {
        let old = block_sums_buf[b];
        block_sums_buf[b] = cumsum;   // replace with emitter-relative cumulative offset
        cumsum += old;
    }
    emitter_alive[eidx] = cumsum;     // total alive for this emitter
}
```

**cs_scatter** uses the prefix and block offset to compute each alive particle's exact destination in compact_buf — no atomics, no races:

```wgsl
@compute @workgroup_size(256)
fn cs_scatter(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(workgroup_id)         wid: vec3<u32>,
) {
    let idx = gid.x;
    if idx >= uniforms.total_particles { return; }
    let p = particles[idx];
    if p.pos_and_alive.w < 0.5 { return; }

    for (var e = 0u; e < uniforms.emitter_count; e++) {
        let em = emitters[e];
        if idx >= em.particle_offset && idx < em.particle_offset + em.particle_count {
            let pos_in_emitter = block_sums_buf[wid.x] + prefix_buf[idx];
            compact_buf[em.particle_offset + pos_in_emitter] = idx;

            // Negated view-space z: positive = far from camera.
            // cs_sort_* will sort this descending for back-to-front order.
            let view_pos = camera.view * vec4<f32>(p.pos_and_alive.xyz, 1.0);
            sort_key_buf[em.particle_offset + pos_in_emitter] = -view_pos.z;
            return;
        }
    }
}
```

### cs_build_multi

One workgroup per emitter. Reads `emitter_alive[eidx]` (written by cs_scan_blocks) and writes a `DrawArgs` struct to the staging buffer:

```wgsl
@compute @workgroup_size(1)
fn cs_build_multi(@builtin(workgroup_id) wid: vec3<u32>) {
    let eidx  = wid.x;
    let em    = emitters[eidx];
    let alive = emitter_alive[eidx];
    draw_args_staging[eidx] = DrawArgs(6u, alive, 0u, em.particle_offset);
}
```

After this pass, `copy_buffer_to_buffer` moves `draw_args_staging` (STORAGE) to `draw_args_buf` (INDIRECT). These must be separate buffers — wgpu prohibits a buffer from being both STORAGE and INDIRECT within the same command scope.

---

## The STORAGE + INDIRECT Split

This is worth explaining clearly because it's a constraint that isn't immediately obvious and breaks silently in the wrong direction.

The first version of Corona had a single indirect buffer created with `STORAGE | INDIRECT`. The compute shader wrote to it as a storage buffer. The render pass read from it as an indirect buffer. wgpu's validation rejected this immediately:

```
wgpu error: Buffer 'Corona Indirect' used with conflicting usages.
Current: BufferUses(STORAGE_READ_WRITE), new: BufferUses(INDIRECT)
```

The fix is two buffers and a copy: `draw_args_staging` has `STORAGE | COPY_SRC` usage and is bound in the compute bind group. `draw_args_buf` has `INDIRECT | COPY_DST` usage and is never bound in any bind group. After the compute passes finish, the encoder records a `copy_buffer_to_buffer`. The render pass reads from `draw_args_buf` exclusively. Each buffer has one usage type in any given render pass scope.

The pattern generalizes: any time you generate indirect arguments on the GPU (dispatch args, draw args, argument buffers), you need this staging split. It's not a Corona-specific workaround — it's how GPU-generated indirect dispatch works across all modern GPU APIs.

---

## The Cursor Problem

Once the basic pipeline was running, particles were appearing and immediately vanishing. Every few frames you'd see a brief flash of geometry and then nothing.

The root cause was in how the demo updates emitters. The Corona demo rebuilds its emitter array every frame to animate emitter positions — the nebula orbits the origin, the fire ring tracks an angle. Each rebuild calls `to_gpu()` on fresh `CoronaEmitterDescriptor` structs. `to_gpu()` initializes `spawn_cursor: 0`.

So every frame the CPU uploaded emitters with cursor = 0. The GPU's `cs_emit` would spawn particles at slots 0..N and write the advanced cursor back to `emitters[eidx].spawn_cursor`. Next frame, the CPU overwrote those cursors with 0 again. The ring buffer never accumulated — every frame started fresh from slot 0, writing over whatever had just been spawned.

The fix is a CPU-side cursor mirror. `CoronaPass` maintains a `cpu_emitters: Vec<GpuCoronaEmitter>` that persists across frames. Each frame in `prepare()`, when new emitter data arrives, the pass merges the incoming params with the tracked cursors and computes how far the cursor should advance this frame:

```rust
let this_cursor = self.cpu_emitters[i].spawn_cursor;
let emit_count  = (src_em.emit_params[0] * dt) as u32;
let range       = aligned_count.max(1);

upload[i] = *src_em;
upload[i].spawn_cursor = this_cursor;

// Mirror what cs_emit will do, so next frame starts where GPU left off.
self.cpu_emitters[i].spawn_cursor = (this_cursor + emit_count) % range;
```

This works as long as `dt` on the CPU equals `uniforms.delta_time` seen by the GPU — which is true because both come from the same source in the render graph.

---

## The Camera Struct Layout Bug

With the cursor problem fixed, particles appeared — but they were enormous white discs that only rendered when the camera was nearly inside the emitter. Moving more than a few meters away made them vanish completely.

The immediate guess was perspective division or depth clipping. The actual cause was subtler: the `CameraUniforms` struct in the WGSL declared its fields in the wrong order relative to the CPU-side `GpuCameraUniforms`.

The CPU struct:
```rust
pub struct GpuCameraUniforms {
    pub view:           [f32; 16],  // offset   0
    pub proj:           [f32; 16],  // offset  64
    pub view_proj:      [f32; 16],  // offset 128
    pub inv_view_proj:  [f32; 16],  // offset 192
    // ...
}
```

The original WGSL struct had `view_proj` first, then `view`, then `proj`. With wgpu running with `InstanceFlags::empty()` (validation disabled, required for some indirect features), there was no error on pipeline creation. The mismatch was entirely silent.

The result: when the vertex shader read `camera.view_proj`, it was actually getting the raw view matrix (no perspective division). `out.pos = view * world_pos` produced view-space coordinates with w=1, which the hardware interpreted as NDC directly. Positions near the camera (view-space z close to 0) happened to land near the screen; positions further away produced positions far outside NDC and were clipped. The billboard axis extraction pulled from the projection matrix columns — meaningless as right/up vectors — which is why the discs were enormous and misaligned.

The fix was one line in the WGSL: reorder the struct fields to match the CPU layout:
```wgsl
struct CameraUniforms {
    view:           mat4x4<f32>,   // offset   0
    proj:           mat4x4<f32>,   // offset  64
    view_proj:      mat4x4<f32>,   // offset 128
    inv_view_proj:  mat4x4<f32>,   // offset 192
    // ...
}
```

The lesson is worth stating directly: on any wgpu context with validation disabled, a mismatch between CPU struct layout and WGSL struct layout produces silent garbage rather than an error. The garbage can look plausible enough — particles near the camera, some light reaching the screen — that it's easy to chase wrong hypotheses first.

---

## Why Compaction, Not Draw-All-Discard

An earlier version of the vertex shader discarded dead particles by outputting an out-of-frustum clip position:

```wgsl
if p.pos_and_alive.w < 0.5 {
    out.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
    return out;
}
```

This works. The GPU clips triangles outside NDC before the fragment shader, so dead particles cost roughly one vertex shader invocation each. For 1,048,576 slots that's six million vertex invocations per frame to produce zero visible output — just to tell the hardware to throw them away.

Compaction moves that cost to compute. The compact pass is O(total_slots) — every slot is visited regardless of whether it's alive. But compute is cheap and massively parallel. The expensive part is the rasterizer, the vertex attribute reads, the fragment shader, and the memory traffic of sampling the texture. Compaction makes all of that O(alive) rather than O(total_slots). For a sparse system — many emitters with long lifetimes — the rendering cost drops proportionally to the alive fraction, which is typically much less than one.

The tradeoff: three additional compute passes (scan_local, scan_blocks, scatter) that are always-on. For dense systems where most slots are occupied, compaction's overhead exceeds its savings. For the typical particle effect — a fountain with a few thousand active particles in a pool of a hundred thousand slots — it's solidly worth it.

---

## Per-Emitter Indirect Draw

With compaction, each emitter's alive particles occupy a contiguous sub-range of compact_buf starting at `particle_offset` with length `alive_count`. This maps directly onto `draw_indirect`:

- `first_instance = particle_offset` — where in compact_buf the GPU starts reading instance indices
- `instance_count = alive_count` — how many instances to draw

One `DrawArgs` per emitter, written by cs_build_multi, copied to the INDIRECT buffer. The render loop issues one `draw_indirect` per emitter:

```rust
let stride = std::mem::size_of::<GpuCoronaDrawIndirect>() as u64;
for i in 0..emitter_count {
    pass.draw_indirect(&self.draw_args_buf, i as u64 * stride);
}
```

In the vertex shader, `@builtin(instance_index)` runs from `particle_offset` to `particle_offset + alive_count - 1`. `compact_buf[instance_index]` gives the actual particle buffer index. The vertex shader reads that particle, extracts the billboard position, and looks up the emitter for the sprite atlas index via `velocity.w`.

Four emitters means four draw calls. The driver overhead for four indirect draws is negligible.

---

## Depth-Sorted Transparency

Alpha-blended particles composited in arbitrary order produce visible errors where emitters overlap or where a near particle happens to compact before a far one. Sorting eliminates this.

We implemented a bitonic sort over compact_buf per emitter using a descending key: negated view-space z, written to `sort_key_buf` by cs_scatter. Positive key = far from camera = drawn first. Bitonic sort in descending order puts the maximum (furthest particle) at position 0 within each emitter's range, which is what `draw_indirect` draws first.

The sort runs as multiple compute passes — one per bitonic stage step. For a 262,144-particle emitter (log₂N = 18), the pass count using a hybrid shared-memory / global-memory approach works out to about 66 dispatches: one initial local sort (all stages for k=2..256 in shared memory), then for each larger k, one global dispatch per step where j ≥ 256 and one shared-memory merge dispatch for j < 256.

Four emitters totals around 220 dispatches per frame. When we first measured this on real hardware the GPU frame time jumped from 2–3ms to 34ms. The problem wasn't the GPU work — it was the per-dispatch overhead. `begin_compute_pass` / `end_compute_pass` pairs are not free in any GPU API, and 220 of them per frame is a significant CPU-side submission cost even before the GPU starts doing anything.

The fix: gate it behind a flag.

```rust
/// Enable per-emitter back-to-front depth sort before rendering.
/// Costs ~50–220 compute dispatches per frame depending on emitter sizes.
/// Leave false for additive effects (fire, sparks) — order-independent.
/// Set true only for alpha-blended volumetric effects (smoke, clouds).
pub depth_sort_enabled: bool,
```

For fire, sparks, and energy effects — which represent most particle use cases — sorting is not needed. Additive blending is commutative: the result of compositing particles in any order is the same. Only alpha-blend effects (smoke, clouds, soft volume fog) actually require sorted order, and those are a minority of effects in practice.

The sort architecture is correct. The infrastructure is there. Enabling it for a specific emitter set costs what it costs and produces correct back-to-front compositing. The performance fix for high-particle-count sorted effects is to collapse multiple sort steps into fewer dispatch calls — either through explicit GPU pipeline chaining or by building the sort steps into a single multi-stage shader using subgroup operations where supported. That's work for another pass.

---

## Sprite Atlas

Every particle in the initial system sampled the same procedural soft-circle texture. Adding a 4×4 sprite atlas with 16 distinct shapes was the smallest change by impact and is what makes the system actually usable for varied effects.

The atlas is 128×128 pixels, 4 cells across, each cell 32×32. We generate all 16 sprites procedurally at initialization time:

- **Row 0** (sprites 0–3): Soft blobs with varying core sharpness — from a wide gaussian falloff to a near-hard-edged disc.
- **Row 1** (sprites 4–7): Rings with varying inner radius. Thick halos, thin rings, soft donuts.
- **Row 2** (sprites 8–11): Star shapes with 4 to 8 points, generated by dividing the radial distance by a modulated angular factor.
- **Row 3** (sprites 12–15): Sparkles — elongated cross/streak shapes at varying aspect ratios for directional spark effects.

Each emitter selects a sprite via `texture_index` (0–15, negative = default soft circle). The vertex shader reads the emitter index from `particle.velocity.w` and looks up the sprite:

```wgsl
let emitter_idx = min(u32(p.velocity.w + 0.5), uniforms.emitter_count - 1u);
let tex_raw     = emitters[emitter_idx].texture_index;
let sprite      = select(u32(tex_raw) % 16u, 0u, tex_raw < 0);
out.sprite_index = sprite;
```

The fragment shader maps the sprite index to an atlas UV region:

```wgsl
let col = in.sprite_index % ATLAS_COLS;
let row = in.sprite_index / ATLAS_COLS;
let atlas_uv = vec2<f32>(
    (f32(col) + in.uv.x) * 0.25,
    (f32(row) + in.uv.y) * 0.25,
);
let tex = textureSample(particle_tex, particle_sampler, atlas_uv);
```

`sprite_index` is passed from vertex to fragment as a flat-interpolated u32 (`@interpolate(flat)`), which is valid in WGSL. The texture sampling itself is unchanged — one `textureSample` call against the atlas, which the hardware handles as efficiently as a single-sprite texture of the same dimensions.

---

## The Unified Bind Group

The shader has twelve bindings shared across all compute and render entry points:

```wgsl
@group(0) @binding(0)  var<uniform>             uniforms;        // delta_time, counts, sort params
@group(0) @binding(1)  var<storage, read_write>  particles;
@group(0) @binding(2)  var<storage, read_write>  emitters;
@group(0) @binding(3)  var<storage, read_write>  compact_buf;
@group(0) @binding(4)  var<storage, read_write>  emitter_alive;  // non-atomic u32
@group(0) @binding(5)  var<storage, read_write>  draw_args_staging;
@group(0) @binding(6)  var<uniform>              camera;
@group(0) @binding(7)  var<storage, read_write>  prefix_buf;
@group(0) @binding(8)  var<storage, read_write>  block_sums_buf;
@group(0) @binding(9)  var<storage, read_write>  sort_key_buf;
@group(0) @binding(10) var                       particle_tex;
@group(0) @binding(11) var                       particle_sampler;
```

A single pipeline layout covers all pipelines — compute and render. The BGL declares each binding with the union of all shader stage visibilities that need it. This means one `wgpu::BindGroup` for the entire pass, created once and reused across all nine compute passes and the render pass. No rebinding between passes; no multiple BGLs to keep in sync.

The tradeoff is that the BGL is large (12 entries) and some entries declare visibility across stages that technically don't use them. wgpu's pipeline validation only checks that a shader's accessed bindings are covered by the layout — it doesn't fail if the layout includes bindings unused by a given entry point. The single-layout approach is simpler in practice than maintaining a compute BGL and a render BGL separately.

The `emitter_alive` buffer is declared as `array<u32>` rather than `array<atomic<u32>>`. With the prefix sum approach, cs_scan_blocks is the only writer and cs_build_multi is the only reader. Sequential access between passes means no atomics are needed. If you revert to the global-atomic compaction approach (simpler but contentious), this buffer needs to go back to `array<atomic<u32>>` and the BGL must be declared accordingly.

---

## The Sort Params Problem

The sort needs to communicate `(k, j, lo, n)` — the current bitonic stage parameters and the emitter's particle range — to each sort dispatch. There's no clean way to do this within a single wgpu command encoder without either push constants (a feature not universally available) or copying new data into the uniform buffer between dispatches.

We use the latter. The `GpuCoronaUniforms` struct is extended with four sort fields:

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct CoronaUniforms {
    delta_time:      f32,
    total_particles: u32,
    emitter_count:   u32,
    frame_count:     u32,
    sort_k:          u32,   // current bitonic stage
    sort_j:          u32,   // current step size (0 = local sort, MAX = local merge)
    sort_lo:         u32,   // emitter particle_offset
    sort_n:          u32,   // emitter particle_count
}
```

At `prepare()` time, all sort steps for the current emitter configuration are pre-computed and written to `sort_steps_buf` (STORAGE | COPY_SRC):

```rust
fn push_sort_steps(lo: u32, n: u32, out: &mut Vec<SortStep>) {
    // Initial block sort (k=2..256 in shared memory).
    out.push(SortStep { k: 256, j: 0, lo, n });

    let mut k = 512u32;
    while k <= n {
        let mut j = k >> 1;
        while j >= 256 { out.push(SortStep { k, j, lo, n }); j >>= 1; }
        out.push(SortStep { k, j: u32::MAX, lo, n });  // local merge
        k <<= 1;
    }
}
```

In `execute()`, before each sort dispatch, 16 bytes are copied from the precomputed step into the sort fields of `uniform_buf`:

```rust
ctx.encoder.copy_buffer_to_buffer(
    &self.sort_steps_buf, step_idx as u64 * step_size,
    &self.uniform_buf,    16,   // byte offset of sort_k
    step_size,
);
```

The encoder executes copies in order, so each dispatch sees the parameters intended for it. `copy_buffer_to_buffer` is a GPU command (recorded into the encoder, not submitted to the queue immediately), which means it obeys the same memory ordering rules as compute passes. The sort_key_buf is written by cs_scatter before any sort dispatches run, so there's no hazard on that side.

---

## The Demo

The demo runs four emitters:

```rust
let fountain = CoronaEmitterDescriptor {
    max_particles:      262_144,
    emit_rate:          8000.0,
    lifetime:           3.0,
    lifetime_variation: 1.0,
    start_size:         [0.8, 0.8],
    end_size:           [0.05, 0.05],
    start_color:        [0.2, 0.6, 1.0, 1.0],
    end_color:          [0.0, 1.0, 1.0, 0.0],
    velocity:           [0.0, 8.0, 0.0],
    velocity_variation: [3.0, 2.0, 3.0],
    gravity:            -5.0,
    shape:              CoronaEmitterShape::Point,
    texture_index:      0,   // soft blob
    position:           [0.0, 0.0, 0.0],
};
```

All four emitters are rebuilt every frame with time-varying positions — the nebula orbits the origin, the fire ring tracks an angle. This is the update pattern that originally exposed the cursor reset bug. With CPU cursor tracking in place, the rebuild is transparent: emitter positions change every frame, but particles accumulate correctly because `prepare()` preserves and advances the cursor independently of the incoming emitter data.

The GPU frame time with all four emitters, prefix-sum compaction, and depth sort disabled is 2–3ms. With depth sort enabled for all four emitters it climbs to ~34ms — effectively the dispatch overhead tax. Enabling depth sort selectively (just for the nebula and galaxy, which use alpha blending) and leaving it off for the fountain and fire ring (additive) would bring that figure down proportionally.

---

## What's Left

**Depth sort dispatch efficiency.** The current implementation issues one `begin_compute_pass` / `end_compute_pass` pair per bitonic step. A production implementation would collapse multiple steps into fewer dispatches: the shared-memory steps for a given k-stage can all run within one shader dispatch by looping over decreasing j with workgroup barriers, and the sort setup overhead itself could be reduced with push constants (`wgpu::Features::PUSH_CONSTANTS`) rather than copying into the uniform buffer 200 times. Both changes would bring the sort cost from dispatch-overhead-dominated to GPU-work-dominated.

**Per-particle sprite animation.** The current atlas selection is per-emitter — every particle from a given emitter draws the same sprite. Per-particle animation (cycling through sprites over the particle's lifetime) is one additional expression in the vertex shader: `let frame = u32(p.size_lifetime_age.w / p.size_lifetime_age.z * f32(num_frames)) % num_frames;`. The infrastructure is there; the demo just doesn't use it yet.

**Additive blend mode per emitter.** Right now all emitters share the same alpha-blend pipeline. Fire and sparks look better with additive blending (commutative, no sort needed). Supporting per-emitter blend mode means either multiple render pipelines or a material system that can switch between them, with the draw loop issuing `set_pipeline` calls between emitters where the blend mode changes.

Corona is part of Helio, open at [github.com/Far-Beyond-Pulsar/Helio](https://github.com/Far-Beyond-Pulsar/Helio).
