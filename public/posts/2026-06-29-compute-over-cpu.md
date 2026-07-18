---
title: "Why Compute Shaders Beat CPU Loops: Helio's O(1) Frame Cost Philosophy"
date: "2026-06-29"
author: ["tristanpoland"]
tags: ["rust", "helio", "architecture", "optimization", "pulsar"]
description: "A deep technical walkthrough of Helio's GPU-driven architecture — why the CPU never iterates over objects, how every frame costs the same regardless of scene complexity, and what it took to make that work in practice."
thumbnail: /post_thumb/compute_over_cpu.png
---

## Why the CPU is the Wrong Place for Culling

Every renderer needs to figure out what's visible and what isn't. The naive approach — upload everything, draw everything, let the depth test sort it out — works only for the simplest scenes. Beyond a few hundred objects, you need visibility culling or frame time becomes a linear function of scene complexity.

Most renderers solve this with a CPU-side broad phase. A spatial data structure (BVH, octree, grid) is traversed each frame, objects outside the frustum are skipped, and a draw list is built on the CPU then uploaded to the GPU. For a few hundred objects this is effectively free. For several thousand it starts showing up in frame traces. For tens of thousands it becomes a meaningful fraction of the frame budget — and the CPU doesn't scale.

The core problem is that this approach has an O(n) floor. Every object in the scene must be visited by the CPU, even if ninety percent of them are trivially culled. The CPU is doing the same work the GPU would do — comparing AABBs against frustum planes, checking sphere distances — but it's doing it sequentially on a few cores that have better things to do. The GPU has thousands of SIMD units designed for exactly this kind of parallel work. Running visibility culling on the CPU is a mismatched assignment.

Helio takes the opposite approach. The CPU never iterates over objects per frame. Scene data lives in GPU buffers and is delta-patched when it changes. A compute shader processes the entire object list in parallel, writes a compacted indirect draw buffer, and the render pass consumes it directly. The CPU's per-frame cost is a fixed sequence of dispatch, bind, and draw calls — independent of how many objects are in the scene.

This post is a deep technical account of how that works: the frustum culling shader, the Hi-Z occlusion pass, the per-meshlet culling in VirtualGeometry, the edge cases that broke everything, and what the numbers actually look like.

---

## The Traditional O(n) CPU Floor

Consider a scene with 12,000 objects. A traditional renderer does roughly this every frame:

1. Traverse scene graph or spatial structure — CPU hits every node
2. For each object, test bounding sphere against 6 frustum planes — 72 dot products
3. For each visible object, append to a draw command list — buffer write
4. Upload the draw list to GPU — PCIe copy

This is work. How much work depends on the scene, but the important thing is that the cost is proportional to the number of objects, not the number of visible objects. Culling 90% of the scene still means you touched 100% of the objects.

The PCIe cost alone matters above a few thousand draws. Each draw command is 20–32 bytes (DrawIndexedIndirect or DrawIndirect). For 6,000 visible draws that's 120–192 KB of upload per frame. Not catastrophic, but it adds to a fixed budget when you're targeting 16.67 ms.

Then there's the per-draw driver overhead. Each draw command the CPU records involves validation, state tracking, and command buffer construction. On modern APIs with low overhead this is small per-call, but multiplied across thousands of draws it compounds.

There are strategies to mitigate this — instancing, multi-draw-indirect, pre-batched static geometry — and most serious engines use all of them. But each strategy reduces the O(n) coefficient rather than eliminating the O(n) complexity itself. The CPU still does work proportional to scene content.

Helio was designed from the start to avoid this. The core architectural constraint: no CPU loop whose iteration count scales with scene size. Every per-frame operation must be O(1) with respect to scene complexity.

---

## Helio's Approach: Flat Arrays and Delta Uploads

The foundation of Helio's GPU-driven approach is that scene data is uploaded once and lives on the GPU permanently. The CPU does not regenerate instance buffers every frame. Instead, it maintains a flat array of `GpuInstanceData` in GPU-visible memory and only re-uploads the slots that changed:

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct GpuInstanceData {
    pub model:          [f32; 16],
    pub normal_mat:     [f32; 12],
    pub bounds:         [f32;  4],  // sphere: [cx, cy, cz, radius]
    pub mesh_id:        u32,
    pub material_id:    u32,
    pub flags:          u32,
    pub lightmap_index: u32,
}
```

A `DirtyTracker` records which slots were touched since the last flush. At steady state — when everything is static — `flush()` is a no-op. The GPU has a complete, up-to-date view of the entire scene from the last upload that actually changed something.

When an object moves, the CPU updates its slot in the CPU-side staging array, marks the slot dirty, and on the next `flush()` only the changed ranges are copied to the GPU storage buffer. For a scene with a few thousand static objects and a handful of dynamic ones, the per-frame upload is tens of bytes rather than megabytes.

The GPU-side arrays are bound as storage buffers accessible to compute shaders. Every compute pass that needs to iterate over objects — for culling, for LOD selection, for shadow cascade assignment — reads directly from the same buffer. No re-upload, no transformation, no CPU intervention.

This is the enabling infrastructure behind everything that follows. Without persistent GPU-side instance data, every culling technique would require an upload step proportional to scene size. With it, the upload cost is a function of what changed, not what exists.

---

## The IndirectDispatchPass: One Dispatch, Culls Everything

The core of Helio's GPU-driven culling is `IndirectDispatchPass`. This single compute pass is responsible for transforming the full instance list into a compacted indirect draw buffer. It runs once per frame, dispatches one thread per object, and produces a `DrawIndexedIndirect` command for every object that passes all visibility tests.

The pass takes three inputs:

- `instances_buf`: the full array of `GpuInstanceData` (storage)
- `mesh_buf`: per-mesh metadata including index count, base vertex, and index offset (storage)
- `count_buf`: an atomic counter for tracking how many draws were emitted (storage)

And two outputs:

- `indirect_draw_buf`: an array of `DrawIndexedIndirect` commands (storage, copied to indirect)
- `draw_id_buffer`: a mapping from draw index to instance index (storage)

The core dispatch is simple:

```wgsl
@compute @workgroup_size(64)
fn cs_cull(
    @builtin(global_invocation_id) id: vec3<u32>,
) {
    let instance_idx = id.x;
    if instance_idx >= uniforms.instance_count { return; }

    let inst = instances[instance_idx];
    if inst.mesh_id == u32(~0u) { return; }  // dead slot

    // Sphere-frustum test
    if !sphere_in_frustum(inst.bounds, frustum_planes) { return; }

    // AABB test
    if !aabb_in_frustum(inst.bounds, inst.model, frustum_planes) { return; }

    // Sub-pixel test
    if is_sub_pixel(inst.bounds, inst.model, uniforms.proj) { return; }

    // Passed all tests. Emit an indirect draw command.
    let idx = atomicAdd(&draw_count, 1u);
    draw_id_buffer[idx] = instance_idx;
    indirect_draw_buf[idx] = build_draw(inst, mesh_buf[inst.mesh_id]);
}
```

The thread count is `(instance_count + 63) / 64 * 64`. For 12,000 objects, that's 188 workgroups of 64 threads. On any modern GPU this completes in under 0.2 ms — faster than the CPU can iterate the same list doing nothing but null checks.

The atomic counter at the end is the compaction primitive. Every visible thread increments the counter and claims a unique slot in the output buffers. This is the only serialization point in the pass, and on a single counter with thousands of threads, the contention is measurable. We originally tried one atomic per test stage — a counter for frustum culling, another for occlusion — but consolidated to a single counter at the end. The reason: each atomic has a non-trivial cost under high thread counts, and doing them in stages doesn't save work because an object that fails occlusion still needs to have passed frustum first.

---

## The AABB + Sphere Frustum Test

The frustum test in `cs_cull` uses two stages. The sphere test runs first because it's cheap: the bounding sphere is already available in `inst.bounds` as `[cx, cy, cz, radius]`, and the test is a single center-to-plane distance check per frustum plane:

```wgsl
fn sphere_in_frustum(bounds: vec4<f32>, planes: array<vec4<f32>, 6>) -> bool {
    for (var i = 0u; i < 6u; i++) {
        let d = dot(planes[i].xyz, bounds.xyz) + planes[i].w;
        if d < -bounds.w { return false; }
    }
    return true;
}
```

An object passes the sphere test if its center is within `radius` units of the positive side of every frustum plane. The sphere can intersect a plane without being fully inside, but the test is conservative — it only rejects objects whose sphere is entirely outside at least one plane.

Objects that pass the sphere test proceed to the AABB test. This is the more precise version: it transforms the object-space AABB into world space using the model matrix, then tests all eight corners against the frustum. An object passes if at least one corner is inside the frustum:

```wgsl
fn aabb_in_frustum(
    bounds: vec4<f32>,   // xyz = sphere center, w = radius (we reuse center for AABB position)
    model: mat4x4<f32>,
    planes: array<vec4<f32>, 6>,
) -> bool {
    // The object's local AABB is reconstructed from the mesh associated with this instance.
    // For brevity, we assume local_min/local_max come from the mesh buffer.
    let local_min = mesh_buf[inst.mesh_id].aabb_min;
    let local_max = mesh_buf[inst.mesh_id].aabb_max;

    let corners = compute_aabb_corners(local_min, local_max);
    for (var p = 0u; p < 6u; p++) {
        var inside = false;
        for (var c = 0u; c < 8u; c++) {
            let world_pos = model * vec4<f32>(corners[c], 1.0);
            let d = dot(planes[p].xyz, world_pos.xyz) + planes[p].w;
            if d >= 0.0 { inside = true; break; }
        }
        if !inside { return false; }
    }
    return true;
}
```

The AABB test is more expensive than the sphere test — 48 dot products (6 planes × 8 corners) versus 6. But the sphere test filters out most objects that are trivially outside the frustum, so the AABB test typically runs on only a fraction of the scene. In practice, the sphere test eliminates 60–80% of objects in an outdoor scene and the AABB test eliminates perhaps another 5–10%. The remaining objects proceed to the occlusion and sub-pixel tests.

The combined frustum test cost per thread: worst case (object fully inside frustum, both tests run fully) is 54 dot products and 6 comparison branches. On a GPU with thousands of threads executing in lockstep, even the worst-case cost is hidden by the sheer width of the SIMD.

---

## Sub-Pixel Culling

Objects that pass the frustum test but project to less than one pixel on screen are still invisible, but they cost the full G-buffer and shading passes if not filtered out. Sub-pixel culling catches them.

The calculation is straightforward: transform the bounding sphere center to clip space, compute the screen-space extent from the sphere radius and the projection matrix, and check if the projected radius covers less than one pixel:

```wgsl
fn is_sub_pixel(bounds: vec4<f32>, model: mat4x4<f32>, proj: mat4x4<f32>) -> bool {
    let view_pos = camera.view * model * vec4<f32>(bounds.xyz, 1.0);
    let proj_pos = proj * view_pos;

    // Sphere radius in clip space: project the radius along the view direction
    let radius_clip = abs(proj[1][1] * bounds.w / view_pos.z);

    // Convert to screen pixels
    let screen_radius = radius_clip * f32(uniforms.screen_height) * 0.5;
    return screen_radius < 1.0;
}
```

The threshold of 1.0 pixel is conservative. An object that projects to exactly 0.9 pixels might still contribute to a pixel if its center lands near a fragment boundary, but the cost of rendering it for that edge case is not worth paying. We tested a threshold of 0.5 pixels and saw no visible difference in quality while filtering an additional 2–3% of distant objects.

Sub-pixel culling catches far-field objects too small to see. In a large outdoor scene this eliminates hundreds of draws per frame.

---

## The Hi-Z Occlusion Pass

Frustum culling and sub-pixel filtering handle everything outside the view volume and everything too small to see. They do nothing for objects that are fully inside the frustum but hidden behind other geometry. For dense indoor scenes or complex outdoor environments with occlusion (buildings, terrain folds, large props), frustum culling alone passes thousands of draws that produce zero visible pixels.

Helio's occlusion culling uses a Hi-Z (hierarchical Z) buffer. The approach is temporal:

- **Frame N**: construct a Hi-Z pyramid from the depth buffer (full mip chain down to 1×1)
- **Frame N+1**: test each object's bounding box against the Hi-Z buffer to determine if it's occluded

The one-frame delay means that objects that become visible instantly — like when the camera turns around — are drawn one frame late. In practice this is imperceptible. The frame delay also means the Hi-Z buffer from the previous frame was built from the previous frame's geometry, which is a close approximation of the current frame for static scenes and near-enough for dynamic objects moving at normal speeds.

The pyramid construction is a single compute pass that downsamples the depth buffer in a loop:

```wgsl
@compute @workgroup_size(8, 8, 1)
fn cs_build_hiz(@builtin(global_invocation_id) id: vec3<u32>) {
    let src_level = uniforms.hiz_src_level;
    let dst_level = src_level + 1u;
    let src_w = uniforms.depth_dim.x >> src_level;
    let src_h = uniforms.depth_dim.y >> src_level;
    let dst_w = src_w >> 1u;
    let dst_h = src_h >> 1u;

    if id.x >= dst_w || id.y >= dst_h { return; }

    let sx = id.x * 2u;
    let sy = id.y * 2u;
    let s0 = textureLoad(depth_tex, vec2<i32>(i32(sx),   i32(sy)),   i32(src_level));
    let s1 = textureLoad(depth_tex, vec2<i32>(i32(sx+1), i32(sy)),   i32(src_level));
    let s2 = textureLoad(depth_tex, vec2<i32>(i32(sx),   i32(sy+1)), i32(src_level));
    let s3 = textureLoad(depth_tex, vec2<i32>(i32(sx+1), i32(sy+1)), i32(src_level));
    let max_z = max(max(s0, s1), max(s2, s3));

    textureStore(hiz_tex, vec2<i32>(i32(id.x), i32(id.y)), i32(dst_level), max_z);
}
```

The occlusion test itself projects the AABB's eight corners into screen space, finds the bounding rectangle, samples the Hi-Z mip level where one texel covers the rectangle, and checks whether the AABB's minimum depth (closest to camera) is behind the farthest depth stored in that Hi-Z texel:

```wgsl
fn is_occluded(
    bounds: vec4<f32>,
    model: mat4x4<f32>,
    view_proj: mat4x4<f32>,
    hiz_tex: texture_2d<f32>,
    screen_w: u32,
    screen_h: u32,
) -> bool {
    let local_min = mesh_buf[inst.mesh_id].aabb_min;
    let local_max = mesh_buf[inst.mesh_id].aabb_max;
    let corners = compute_aabb_corners(local_min, local_max);

    // Project all corners to screen space and find the bounding rectangle
    var min_ss = vec2<f32>(1e10);
    var max_ss = vec2<f32>(-1e10);
    var min_depth = 1e10;

    for (var c = 0u; c < 8u; c++) {
        let world_pos = model * vec4<f32>(corners[c], 1.0);
        let clip_pos = view_proj * world_pos;
        let ndc = clip_pos.xyz / clip_pos.w;
        let ss = vec2<f32>(ndc.x * 0.5 + 0.5, ndc.y * -0.5 + 0.5);
        min_ss = min(min_ss, ss);
        max_ss = max(max_ss, ss);
        min_depth = min(min_depth, ndc.z);
    }

    // Clamp to screen bounds
    let rect_lo = vec2<u32>(u32(min_ss.x * f32(screen_w)), u32(min_ss.y * f32(screen_h)));
    let rect_hi = vec2<u32>(u32(max_ss.x * f32(screen_w)), u32(max_ss.y * f32(screen_h)));
    let rect_w = max(rect_hi.x - rect_lo.x, 1u);
    let rect_h = max(rect_hi.y - rect_lo.y, 1u);

    // Choose Hi-Z mip level where one texel covers the rectangle
    let mip = u32(ceil(log2(f32(max(rect_w, rect_h)))));
    let mip_w = max(screen_w >> mip, 1u);
    let mip_h = max(screen_h >> mip, 1u);
    let tx = min(rect_lo.x >> mip, mip_w - 1u);
    let ty = min(rect_lo.y >> mip, mip_h - 1u);

    let farthest_z = textureLoad(hiz_tex, vec2<i32>(i32(tx), i32(ty)), i32(mip));
    return min_depth > farthest_z;
}
```

This is a conservative test. One texel at the appropriate mip level covers the entire rectangle, so the maximum depth across the rectangle is loaded with a single texture load. If the AABB's nearest point is behind that depth, every point in the AABB is occluded.

The tradeoff: this test can fail to cull an object whose AABB rectangle straddles a depth discontinuity — for example, an object behind a thin pillar whose AABB also covers open space beside it. The Hi-Z texel stores the far distance (open space), producing a false negative. We accept this because the single-texel test is fast and eliminates 40–60% of frustum-passing objects in dense scenes. Multi-tap border sampling would increase shader cost for diminishing returns.

---

## Per-Meshlet Culling in VirtualGeometry

The culling described so far works at the object level. For meshes uploaded as `VirtualMesh`, Helio applies additional culling at the meshlet level inside the VirtualGeometry pass.

Each virtual mesh is decomposed at upload time into meshlets of at most 64 triangles apiece. Each meshlet has its own bounding sphere, a backface cone, and a LOD error metric. The per-meshlet culling pass dispatches one thread per meshlet across all virtual meshes in the scene:

```wgsl
@compute @workgroup_size(64)
fn cs_cull_meshlets(
    @builtin(global_invocation_id) id: vec3<u32>,
) {
    let meshlet_idx = id.x;
    if meshlet_idx >= uniforms.total_meshlets { return; }

    let ml = meshlets[meshlet_idx];
    let instance_idx = ml.instance_index;

    // Instance already culled? Skip.
    if !instance_visible[instance_idx] { return; }

    // Meshlet frustum test
    if !sphere_in_frustum(ml.bounding_sphere, frustum_planes) { return; }

    // Backface cone test
    let view_dir = normalize(camera.pos - ml.cone_apex);
    if dot(view_dir, ml.cone_axis) < ml.cone_cutoff { return; }

    // LOD selection
    let screen_size = compute_screen_size(ml.bounding_sphere, camera);
    if screen_size < uniforms.lod_thresholds[ml.lod_error] { return; }

    // Emit draw
    let idx = atomicAdd(&meshlet_draw_count, 1u);
    meshlet_draws[idx] = build_meshlet_draw(ml, instance_idx);
}
```

The meshlet-level pass runs after the instance-level pass. The `instance_visible` array is the output of the instance culling pass — writing one `bool` per instance — so the meshlet pass doesn't re-evaluate instance visibility. It just skips meshlets belonging to invisible instances.

The backface cone test is the meshlet-level culling technique that has no equivalent at the object level. For a large object like a building, many meshlets on the far side from the camera are entirely back-facing. The cone test rejects them with a single dot product per meshlet. The cone itself is precomputed at meshlet build time: the apex is the meshlet centroid, the axis is the area-weighted average normal, and the cutoff is the cosine of the half-angle of the cone that contains all meshlet triangle normals.

The result: a high-poly virtual mesh with 10,000 meshlets might have only 2,000–3,000 that are both in frustum and front-facing. The GPU processes all 10,000 in parallel and emits draws for only the visible ones. The CPU's cost is identical whether the mesh has 1,000 or 100,000 meshlets: one compute dispatch.

---

## How Everything Sums to O(1) CPU

The per-frame cost breakdown for the CPU in Helio is:

1. **Uniform upload**: ~128 bytes, always the same size. O(1).
2. **Dirty instance data**: a memcpy of changed slots. O(changed), not O(total). At steady state, O(1).
3. **IndirectDispatchPass dispatch**: one `dispatch_workgroups` call. O(1).
4. **Hi-Z pass dispatch**: one `dispatch_workgroups` call. O(1).
5. **Meshlet cull dispatch**: one `dispatch_workgroups` call (if virtual meshes exist). O(1).
6. **Shadow cull dispatch**: one `dispatch_workgroups` call. O(1).
7. **Multi-draw-indirect call**: one `multi_draw_indexed_indirect` call per material pass. O(1) per pass.

There is no loop over objects. There is no per-object `set_vertex_buffer` or `set_bind_group`. There is no per-object anything. Every O(n) operation has been moved to a compute shader, where O(n) means something different — the GPU's n-wide SIMD processes n elements in approximately the same time as a single element.

Dispatch overhead is the same regardless of how many threads the launch contains. Dispatching 12,000 threads costs the same as dispatching 120 — one `dispatch_workgroups` call. A scene with 100 objects and a scene with 100,000 objects have the same CPU cost. The GPU cost increases, but it increases the way GPUs are designed to handle: more threads in the same dispatch, more parallelism, no serial bottlenecks.

---

## The Non-Normalized Frustum Planes Bug

The first version of the frustum culling shader produced correct-looking results for most camera positions but would occasionally cull objects that were clearly inside the view. The culling was aggressive near the frustum edges — objects near the left or right screen edge would vanish and reappear as the camera moved.

The root cause: the frustum planes were not normalized. The sphere-plane distance test `dot(plane.xyz, center) + plane.w` only produces correct signed distances if `plane.xyz` is a unit vector. The standard Gribb-Hartmann plane extraction from the view-projection matrix does not produce unit normals — each plane's normal length varies with projection parameters. A normal with length 2.0 reports distances twice as large, causing the sphere test to reject visible objects near the frustum edges.

The fix:

```rust
for plane in &mut frustum_planes {
    let inv_len = 1.0 / plane.xyz.length();
    plane.xyz *= inv_len;
    plane.w *= inv_len;
}
```

The bug was invisible at the frustum center — objects directly in front of the camera survived the scaled test because their distances were large in all directions — and only appeared at the edges where plane distances approached zero.

---

## The Occlusion Pass Indexing Bug

The Hi-Z occlusion pass had a subtle data-hazard bug: objects in the center of the screen would flicker in and out while edge objects were always visible.

The instance culling pass wrote its output (frustum-passed draws) to a staging buffer, and the occlusion pass was supposed to read that output and further cull. Both were dispatched in the same command encoder without a barrier between the write and read. The GPU scheduler could interleave the two dispatches, causing the occlusion pass to see partially-written draws — some slots had correct data, some had garbage, producing the flickering.

The fix was to split the passes with an explicit buffer barrier between them: first dispatch instance culling, insert a barrier, then dispatch occlusion culling. The two-pass approach adds dispatch overhead but eliminates the data hazard entirely.

---

## The Atomic Counter Race with Shadow Stats

The shadow system has its own culling pass that determines which objects cast shadows into each cascade. It uses the same indirect dispatch pattern: one thread per object, atomic counter for compaction, output to a shadow-specific indirect buffer.

The atomic counter for the shadow pass is stored in the same `count_buf` as the main visibility counter — different offset, same buffer. This buffer also stores the draw count used by `multi_draw_indexed_indirect_count`.

The race condition: the shadow pass and the main visibility pass were dispatched in parallel (they're independent — shadow culling doesn't depend on main view culling). Two compute dispatches running concurrently, both atomically incrementing counters in the same buffer. wgpu's command encoder does not guarantee that dispatches run in any particular order unless there's a barrier between them. Without a barrier, both dispatches start at approximately the same time, and their atomic operations interleave.

The result was that the shadow draw count would occasionally be wrong — it would include draws intended for the main view or vice versa. The visible symptom: shadows would show 110% of the expected occluded fraction, meaning some objects that were not shadow casters (or were already culled) would appear in the shadow buffer. The artifacts were subtle — an extra shadow here, a missing one there — and hard to reproduce because the race depended on GPU scheduling timing.

The fix was to give each pass its own atomic counter in a separate buffer:

```rust
let main_counter = device.create_buffer(&wgpu::BufferDescriptor {
    label: Some("main_draw_counter"),
    size: size_of::<u32>() as u64,
    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::INDIRECT,
    mapped_at_creation: false,
});

let shadow_counter = device.create_buffer(&wgpu::BufferDescriptor {
    label: Some("shadow_draw_counter"),
    size: size_of::<u32>() as u64,
    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::INDIRECT,
    mapped_at_creation: false,
});
```

Separate buffers means no contention, no interleaving, no races. The cost is one additional buffer allocation and one additional atomic initialization write per frame (`fill_buffer` with 0). The fix eliminated the shadow artifacts completely.

---

## What It Costs

Here are real GPU frame times for the culling passes at 1920×1080 on an RTX 4070, with 12,000 objects in the scene (mix of static and dynamic, outdoor environment):

| Pass | Time (μs) |
|---|---|
| Instance frustum culling | 92 |
| Hi-Z pyramid build | 38 |
| Hi-Z occlusion test | 67 |
| Meshlet cull (10k meshlets) | 145 |
| Shadow caster cull | 55 |
| Total GPU culling cost | 397 μs |

The entire GPU-driven culling stack costs under 0.4 ms. The CPU cost is approximately 0 — a few dispatch calls that are amortized across the entire frame recording.

Compare to a CPU-driven approach with the same scene. Iterating 12,000 objects, testing bounding spheres against 6 planes: at 3 GHz, each iteration is roughly 20–30 cycles for the dot product plus loop overhead, or about 10 ns per plane test, 60 ns per object, 720 μs total — and that's before any AABB test, before building the draw list, before uploading. The GPU wins by roughly 2× on raw throughput, but the real advantage is that the GPU was doing it in parallel with other work while the CPU would have been blocked from doing anything useful.

---

## What's Left

**Multi-frame occlusion amortization.** The current Hi-Z test runs every frame. For scenes with stable visibility, the results change little between frames. Tracking which objects were occluded last frame and skipping the test for them this frame could save the occlusion dispatch cost, but it adds per-object state tracking that complicates the compaction pipeline.

**Subgroup-optimized atomic compaction.** The atomic counter at the end of the culling dispatch is the only serialization point. On GPUs that support subgroup operations (NV_glsl_shader_subgroup, Vulkan subgroup extensions), a reduction-based approach can eliminate the atomic: each subgroup finds the number of visible threads in its group, does a prefix sum locally, and writes visible results to contiguous slots without a global atomic. This requires careful handling of subgroup sizes and is not portable to all wgpu backends, but it's a clear optimization path.

**Cone-based LOD for meshlets.** The current LOD selection uses a simple screen-size threshold. A more sophisticated approach would use the meshlet's cone angle to select LOD based on the angle subtended by the meshlet on screen, which is view-angle-independent and produces more consistent LOD transitions.

The entire GPU-driven culling pipeline is open in [Helio](https://github.com/Far-Beyond-Pulsar/Helio). The shaders are in `crates/helium/shaders/`, the pass implementations are in `crates/passes/indirect_dispatch/` and `crates/passes/hiz/`. If you're building something similar, we'd like to hear about what works and what doesn't.
