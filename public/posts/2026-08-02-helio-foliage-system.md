---
title: "Rendering a Million Blades of Grass: Helio's GPU-Driven Foliage System"
date: 2026-08-02
author: tristanpoland
tags: ["rust", "helio", "graphics", "foliage", "gpu-compute", "rendering", "pulsar"]
description: "Helio's GPU-driven foliage system with tile ring residency, three-band wind, correct motion vectors, and 1M blades under 3ms."
thumbnail: /post_thumb/foliage.png
---

A single blade of grass is a triangle strip that costs nothing. Eleven vertices. No index buffer. `TriangleStrip` topology. Four bytes per instance. A million of them spread across a 120-metre radius around the camera. Each moves in the wind. Each casts a shadow. Each is occlusion-culled against the previous frame's depth. Each writes a correct velocity so TAA does not smear it into a green blur.

Foliage is the most geometry-dense thing a renderer ever draws. It is also the least important thing to draw correctly. A rock that pops is a bug. A blade of grass that pops is barely noticeable. A thousand blades that pop in unison create a shimmer the eye picks up instantly. Human peripheral vision detects sudden disappearance, coherent motion that does not match the wind direction, and edges that flicker under camera motion.

UE5 does not solve all of these. Its grass path places instances on the CPU, culls by distance and frustum only, writes no motion vectors, and pops blades at the cull distance with no fallback. We do not agree with that.

---

## Design Decisions

Every subsystem in Helio's foliage stack made a deliberate choice about where to put the complexity. These are the ones that mattered.

### Placement never touches the CPU

The world is a grid of 8-metre tiles. A ring of tiles around the camera is resident. On camera motion, tiles entering the ring are pushed to a `place_queue`. Tiles leaving are freed LRU. At most 24 tiles are placed per frame. Churn is amortised. A teleport degrades to a few frames of progressive fill-in rather than a hitch.

Placement for one tile is one workgroup. Each lane evaluates a stratified candidate against the density weight and writes survivors into that tile's slab. The process is deterministic: same tile coordinate, same generation, same seed produces a byte-identical blade list on any GPU. This is enforced in CI.

Every placed blade is the output of a pure function:

$$\\text{blade} = f(\\text{tile\\_coord},\\; \\text{lane\\_index},\\; \\text{generation},\\; \\text{seed})$$

The function is evaluated identically in WGSL and in Rust. `tile_coord` identifies the tile. `lane_index` is the blade's position within the tile's stratified candidate grid. `generation` is bumped on every terrain or density edit, so re-placing a tile produces a different deterministic set. `seed` is the layer's authored seed, letting two artists paint different random distributions over the same terrain.

The candidate grid is jittered stratified. Each lane evaluates its cell centre plus a blue-noise offset from `hash(seed, tile_coord, lane)`. It accepts or rejects based on five tests. Is the candidate inside at least one foliage layer's AABB? Does the terrain capture report a valid height at this XZ? Does the pixel density weight pass a threshold test? Does the terrain slope fall within the type's `slope_range`? Does the world altitude fall within the type's `altitude_range`?

### Foliage is occlusion-culled

Two compute dispatches. The tile cull runs one lane per resident tile: a frustum test against the tile AABB dilated by `max_height + wpo_extent`, then a conservative Hi-Z max-depth test. The cluster cull refines this to 4x4 blade clusters. Frustum, Hi-Z, distance-to-LOD classification, then `atomicAdd` append into four per-LOD `visible_blades` buffers. A finalize pass converts counters to `DrawIndirectArgs`. At 1 M blades this is 977 workgroups. The budget is 0.15 ms.

### Impostors are first-class and lit

Helio's impostors are hemi-octahedral atlases baked by `helio-bake`. They are rasterised into the G-buffer with reconstructed normal and depth-parallax. They receive shadows, SSAO, SSR and GI identically to mesh LODs. The atlas is a single `texture_2d_array` with three pages per impostor: base colour + coverage alpha, octahedral-encoded world normal, and view-depth for parallax.

### WPO does not break culling

World-Position-Offset moves vertices. Grass bends in the wind. Displaced geometry can fall outside the object's bounding sphere. A per-type `wpo_extent` dilates the object and meshlet cull radii. A `wpo_disable_distance` disables WPO and stops the dilation in the same frame, driven by the same distance constant. Bounds are never wrong in either direction.

### Wind-correct motion vectors

Helio's foliage vertex shaders evaluate wind at both `t` and `t - dt`. They emit a true `prev_clip_position`. The wind uniform carries both timestamps:

```rust
pub struct GpuWind {
    pub direction_speed: [f32; 4],
    pub gust: [f32; 4],
    pub time_prev_time: [f32; 2],  // t and t - dt
    pub _pad: [f32; 2],
}
```

`prev_time` is what makes dithered LOD cross-fades resolve cleanly instead of ghosting. This is the artefact Unreal Engine grass ships with.

### Interaction is a shipped feature

A camera-relative `Rgba16Float` texture (512 covering 64 m, snapped to the texel grid so there is no swimming). RG store horizontal displacement. B stores vertical crush. A stores a recovery timer. The interaction field decays exponentially per texel. Each interactor is a sphere with position, radius and velocity projected onto the field.

### The far ring has no geometry and no pop

Past the last card LOD the engine stops drawing geometry. The density map feeds the terrain material as albedo, roughness and normal perturbation. Grass dissolves into terrain shading rather than popping out at the cull distance.

---

## The GPU Data Model

We have a budget: 24 MiB for the blade arena at Medium quality. Every blade record costs 16 bytes. At that size the arena holds 1.5 M blades. Every extra byte costs 1.5 MiB of budget and a proportional slice of placement write bandwidth.

### GpuBladeInstance, 16 bytes

```rust
#[repr(C)]
pub struct GpuBladeInstance {
    /// Tile-local XZ as two 16-bit unorms over the tile extent.
    pub packed_pos: u32,
    /// Terrain height offset as f16 | yaw as 16-bit turn.
    pub packed_height_yaw: u32,
    /// Height u8 | width u8 | type id u8 | variant u8.
    pub packed_scale_type: u32,
    /// Tint X u8 | tint Y u8 | stable per-blade seed u16.
    pub packed_tint_seed: u32,
}
```

Every blade stores its position as a fraction of the tile it lives in, not as metres in the world. The arena encodes relative positions that do not change when the tile moves in the residency ring. This is the most important decision in the struct. Placement becomes a pure function, reproducible across GPUs with different FMA behaviour.

The seed in `packed_tint_seed` is the single most load-bearing value. Dithered LOD cross-fades, wind phase offset, per-blade variation. Everything keys off it. It is derived from `(tile_coord, lane, generation)` and never from frame state. A seed that changes between frames turns the stochastic cross-fade into full-screen static that TAA cannot resolve.

### GpuFoliageTile, 32 bytes

```rust
#[repr(C)]
pub struct GpuFoliageTile {
    pub tile_coord: [i32; 2],
    pub blade_offset: u32,
    pub blade_count: u32,
    pub bounds_center_y: f32,
    pub bounds_half_y: f32,
    pub state: u32,     // TileState: Free, Placing, Resident, Evicting
    pub generation: u32,
}
```

At the default ring capacity of 4096 the whole table is 128 KiB. The tile cull pass reads it linearly without an acceleration structure. The `generation` field is bumped whenever the density map or terrain under this tile is edited. Residency is keyed on `(tile_coord, generation)`. A bump invalidates the cached blades without an explicit flush.

### GpuFoliageType, 96 bytes

```rust
#[repr(C)]
pub struct GpuFoliageType {
    pub density: f32,
    pub height_range: [f32; 2],
    pub width_range: [f32; 2],
    pub slope_range: [f32; 2],
    pub altitude_range: [f32; 2],
    pub lod_distances: [f32; 4],
    pub wind_response: [f32; 3],
    pub interaction_stiffness: f32,
    pub material_id: u32,
    pub density_layer: u32,
    pub kind_and_flags: u32,
    pub mesh_or_impostor_id: u32,
    pub _pad: [u32; 3],
}
```

The plan said this struct would be 64 bytes. Its own field list summed to 84. Rounding up to 96 leaves 12 bytes of tail padding. That is deliberate headroom.

Every field in this struct must be declared as a scalar in WGSL. Not one may be a vector type. WGSL gives `vec3<f32>` a 16-byte alignment. `wind_response` is three floats. Someone will reach for `vec3<f32>` without thinking. That pushes the field from offset 52 to 64 and shifts every field after it. Trees render with a random material. Nothing crashes. The cause is twelve bytes of padding rules in a language spec. It costs a day to bisect. We pin every field offset with a test.

### The seed function

```rust
pub const fn blade_seed(tile_coord: [i32; 2], lane: u32, generation: u32) -> u32 {
    let mut h = (tile_coord[0] as u32)
        .wrapping_mul(374761393)
        .wrapping_add((tile_coord[1] as u32).wrapping_mul(668265263))
        .wrapping_add(lane.wrapping_mul(2654435761))
        .wrapping_add(generation.wrapping_mul(2246822519));
    h = (h ^ (h >> 15)).wrapping_mul(2246822519);
    h = (h ^ (h >> 13)).wrapping_mul(3266489917);
    h ^= h >> 16;
    h
}
```

Three inputs. No frame index. No time. No counter. Nothing changes between frames.

### Compile-time size asserts

```rust
const _: () = {
    assert!(std::mem::size_of::<GpuBladeInstance>() == 16);
    assert!(std::mem::size_of::<GpuFoliageTile>() == 32);
    assert!(std::mem::size_of::<GpuFoliageType>() == 96);
};
```

These fail at compile time if the size changes. A size change the shader does not follow does not fail loudly. The shader reads every field from the wrong offset and produces garbage rotations.

---

## Tile Ring Residency Cache

Foliage lives on a grid of 8-metre tiles. A camera-centred square window of these tiles is resident in GPU memory at any time.

| Quality | Ring radius | Tiles | Ring capacity |
|---|---|---|---|
| Low | 32 m | 81 | 81 |
| Medium | 64 m | 289 | 289 |
| High | 128 m | 1089 | 1089 |
| Ultra | 256 m | 4225 | 1089 (clamped, thrashes) |

The simpler implementation rebuilds the resident set from scratch each frame. It is O(area) of the ring. Our `shift_to` method visits only the entering and leaving strips. The cost is proportional to the perimeter of the ring. `4 x tiles_across` for a full one-tile step, not `tiles_across`.

```rust
fn shift_to(&mut self, new_center: [i32; 2]) -> u32 {
    // Two loops: leaving (old \ new), entering (new \ old)
    // Each loop walks perimeter strips only
}
```

In steady state (camera within the same tile), `update` returns zero. All fields zero, no work done. The steady state is free.

When the ring capacity is smaller than the window, the LRU eviction path kicks in. The eviction candidate is the least recently admitted resident tile. The placement budget caps work at 24 tiles per frame so no single frame spikes.

The blade arena is partitioned into equal fixed slabs, one per ring slot. A bump allocator would be simpler but introduces a fragility. With a bump allocator a tile's `blade_offset` would depend on the order tiles were placed in. An evict/re-place cycle would move blades in memory and the arena would fragment under ring churn. Equal slabs also make `blade_index / blades_per_tile` an exact O(1) recovery of the owning tile.

When the CPU uploads a new tile header, it publishes state `Placing`, not `Resident`. The GPU flips the state to `Resident` at the end of `cs_place`. If the CPU published `Resident`, the cull pass could read a slab that placement has not written yet.

---

## GPU Placement and Culling

Four compute stages run in sequence.

Stage one is `cs_place`. One workgroup per queued tile, max 24. Each lane evaluates a stratified candidate. Compaction uses a workgroup prefix sum instead of `atomicAdd`. Atomic ordering is unspecified. An atomic append produces the right set in an arbitrary order. With the scan, a blade's slab index is a pure function of its candidate index.

Stage two is `cs_tile_cull`. One lane per resident tile. Frustum plus Hi-Z occlusion test on the tile AABB.

Stage three is `cs_cluster_cull`. One lane per 4x4 blade cluster. Each lane runs a frustum test against the cluster's bounding sphere, a Hi-Z max-depth test, and LOD classification. Survivors are appended via `atomicAdd` into four per-LOD visible buffers. This is the one place where atomic appends are acceptable. The output is a bag of indices used only for drawing. Ordering does not affect correctness.

Stage four is `cs_finalize`. A single workgroup converts counters to `DrawIndirectArgs`.

| LOD | Range | Geometry | Verts |
|---|---|---|---|
| L0 | 0-8 m | 5-segment blade strip | 11 |
| L1 | 8-20 m | 3-segment blade strip | 7 |
| L2 | 20-45 m | textured card | 4 |
| L3 | 45-120 m | clump card (one per 4x4 cluster) | 4 |
| -- | >120 m | terrain material perturbation | 0 |

Three anti-pop mechanisms. A blade entering the ring interpolates height from 0 to 1 over a 2-metre band. Over the LOD band both representations draw with a stochastic cross-fade keyed on `hash(seed) + blue_noise(pixel, frame)`. L2 and L3 cards inherit the L1 blade's yaw from the same seed hash. The value is continuous by construction.

---

## Wind System

Helio's wind model is a three-band displacement system implemented once in a shared WGSL prelude. Grass blades, tree WPO, and impostor cards all include the same prelude. Two representations of the same plant are on screen simultaneously inside every LOD cross-fade band. If they each grew their own `sin(time)` the silhouettes would shear apart.

The wind clock lives in `Scene`. It is the only wind clock in the renderer. Passes are not allowed to keep their own accumulated time. Two clocks drift. Drifting clocks put blade geometry and impostor cards out of phase at the cross-fade band.

Every foliage vertex shader evaluates the entire wind model twice per vertex:

```wgsl
let wind_now = helio_wind_offset(wind, world_base, root, height_frac, seed, response, time);
let wind_prev = helio_wind_offset(wind, world_base, root, height_frac, seed, response, prev_time);

let position_now  = world_base + wind_now + bend;
let position_prev = world_base + wind_prev + bend;

out.clip_position      = cameras[0].view_proj      * vec4<f32>(position_now,  1.0);
out.prev_clip_position = cameras[0].prev_view_proj * vec4<f32>(position_prev, 1.0);
```

The second evaluation is what fills the G-buffer velocity target. Without `prev_time`, every foliage vertex reports zero motion. TAA reprojects a moving blade onto whatever was behind it. Every blade smears.

### Band 1, trunk sway

Low-frequency, large-amplitude, gust-modulated, coherent across an entire instance. Phase comes from a world-space noise at the instance origin, not the shaded vertex. Sampled at the origin, every vertex of one plant shares a phase. A meadow leans in coherent waves. Sampled per vertex, each plant gets an independent phase. That produces boiling, not blowing.

The coherence constant is 0.06 per metre. At that value, sway phase decorrelates over roughly 16 metres.

The bend uses $\\sin(t) \\cdot 0.75 + \\sin(t \\cdot 2.17 + 1.3) \\cdot 0.25$. The 2.17 is deliberately not an integer. An exact harmonic makes the motion strictly periodic. The eye picks a one-second loop out of a field instantly. Lateral sway is 35% of downwind. A stem that only moves in the wind plane reads as a hinge, not a plant. Amplitude scales with height squared, the first mode shape of a cantilever beam.

### Band 2, branch flutter

Mid-frequency flutter with phase driven by distance along the stem and distance travelled downwind. Base frequency 1.05 Hz. Amplitude 0.008 m per m/s of wind speed.

### Band 3, leaf jitter

High-frequency, low-amplitude jitter with phase from a stable per-leaf seed. This is the one band where per-instance independence is wanted. Individual leaves genuinely do flick independently. The amplitude is small enough that no coherent silhouette depends on it. 2.5 mm per m/s.

### Gust envelope advected downwind

The gust function produces a multiplier across the field. A stationary turbulence field makes every plant in a blotch pulse together forever. An advected field produces a gust front that travels across the field. The advection constant is 0.35.

### Tempo scaling

$$\\text{tempo}(s) = 0.35 + 0.65 \\cdot \\text{clamp}\\left(\\frac{s}{5.0},\\; 0.0,\\; 2.0\\right)$$

At zero speed the multiplier is 0.35. Grass in near-still air drifts instead of freezing solid. At 5 m/s it hits 1.0, the authored base frequency.

### Wind hash, not sin-hash

The noise model uses the lowbias32 integer finaliser. The $\\text{fract}(\\sin(x) \\cdot 43758.5453)$ trick is wrong here. `sin` is only guaranteed to a few ULP. Vendors disagree on large arguments. The same blade hashes differently on two GPUs. Wind phase must be bit-stable. The cross-fade blends two representations of one plant. Any phase difference shows up as a shearing silhouette. The integer-only fix is five operations, no `sin`, bit-stable across every backend.

### What the iteration process taught us

The wind model went through seven iterations. First pass used per-vertex noise driving all three bands. Every blade shimmered independently. It looked like a heat haze, not wind. The fix was moving the sway phase to the instance origin.

Amplitude scaled with speed but frequencies were fixed. Strong wind made everything swing further but not faster. The fix was the tempo ramp.

The turbulence field pulsed in place. Every blade in a blotch leaned together forever. The fix was advecting the noise sample downwind.

The sway band used a single sine. The motion was strictly periodic. The eye picked the loop instantly. The fix was the incommensurate second mode at 2.17x the fundamental.

Early versions only displaced along the wind direction. A stem that only moves in the wind plane reads as a hinge. The fix was lateral sway at 35% of downwind.

Without the sagitta correction, grass grew longer in gusts. The bands displaced horizontally without shortening the stem. The fix was arc-length correction.

The original hash used `fract(sin(x) * 43758.5453)`. On AMD the L2/L3 cross-fade band had a visible shearing artefact. Three days of debugging. The fix was the integer-only lowbias32 finaliser.

---

## Rasterisation

Four `draw_indirect` calls. No vertex buffer. No index buffer.

```rust
for lod in 0..self.decision.draw_count {
    pass.set_bind_group(1, &self.bind_group_1, &[lod * 256]);
    pass.draw_indirect(&self.foliage_indirect, lod as u64 * 16);
}
```

Every vertex is derived from `@builtin(vertex_index)` plus the packed 16-byte `BladeInstance` fetched through `visible_blades[]`. The WebGPU spec's primitive assembly runs per instance. A non-indexed instanced strip draw cannot span an instance boundary. The hardware resets the strip for every `instance_index`. Each blade is exactly one primitive. No degenerate triangles. No index buffer.

The fragment shader declares five outputs. Three more G-buffer targets are masked with `ColorWrites::empty()`. A five-target pipeline was the first draft. It required its own render pass. That breaks subpass fusion. Breaking the chain forces a tile store and reload of every touched attachment. At 1080p and 48 bytes per sample, that is about 100 MiB each way on a tile-based GPU. The correct lever is an 8-target pipeline with three empty write masks.

The stochastic cross-fade blends between LODs. Every blade tests against a threshold composed of a stable per-blade hash and a per-pixel per-frame dither. In the LOD band both representations draw. At any threshold, the near LOD's weight is `f` and the far LOD's is `1 - f`. They sum to exactly one blade's worth of coverage everywhere in the band.

L3 draws one card per 4x4 cluster. That card is four times as wide as a single blade. When the stochastic dither discards it, sixteen blades worth of coverage disappears at once. L3 fades by area instead. The card shrinks toward zero across the band and is never discarded.

The vertex stage generates geometry from `vertex_index` alone. A blade is a triangle strip in row-major, side-minor order. The normal is computed analytically. The strip is two vertices wide. At the collapsed tip, the edge between the two sides has zero width. A finite-differenced normal would divide by zero.

The fragment shader colours grass procedurally. No material table, no textures. The albedo progresses from `(0.055, 0.115, 0.030)` at the root to `(0.180, 0.320, 0.075)` at the tip. The blade is darker near the ground and lighter at the tip where it catches the sun.

---

## Interaction Field

The interaction field is a camera-relative `Rgba16Float` texture. Default size 512 covering 64 metres, snapped to the texel grid. RG store horizontal displacement. B stores vertical crush. A stores a recovery timer.

The field origin is at `floor(camera_position / texel_size) * texel_size`. A texel at pixel (x, y) always samples the same world position regardless of sub-texel camera motion. The field scrolls in whole-texel increments. Without this snap, the interaction displacement would crawl under the grass even when nothing is touching it.

The scroll is a GPU copy from one region to another, offset by the snap delta. The delta is always an integer number of texels. No filtering. No resampling. No information lost.

Each interactor is a sphere with position, radius and velocity. The splat compute shader projects the sphere onto the field. Recovery is exponential. Every texel decays as `value *= exp(-dt / tau)`. When the pass is disabled, the bind group supplies a 1x1 placeholder texture and the shader early-returns. Zero overhead when absent.

---

## Performance Budget

Target is 1 M blades under 3 ms GPU at 1080p. Enforced in CI as a hard failure.

| Stage | Budget |
|---|---|
| Terrain capture | 0.05 ms |
| Interaction field | 0.05 ms |
| Placement | 0.20 ms |
| Tile + cluster cull | 0.15 ms |
| L0 raster | 0.55 ms |
| L1 raster | 0.60 ms |
| L2/L3 raster | 0.95 ms |
| Impostors | 0.15 ms |
| Total | 2.70 ms |

Headroom to the 3.0 ms gate: 0.30 ms.

Shadow casting is staged deliberately. Trees cast via proxy-mesh double publication. Grass casts only within the first cascade, only at L2 cards, into the dynamic atlas. Wind is frozen for the shadow draw. Beyond cascade 0, grass contributes AO instead, via a density term in the terrain material.

---

## Platform Constraints

| Constraint | Answer |
|---|---|
| No `MULTI_DRAW_INDIRECT_COUNT` on WebGPU | Exactly 4 `draw_indirect` calls |
| `MAX_TEXTURES == 16` on wasm/Metal/Android | Single `texture_2d_array`, one binding |
| No 64-bit atomics | All counters are `atomic<u32>` |
| Tile-based mobile GPUs hate alpha test | Opaque blade geometry at L0/L1; cards use stochastic alpha-test plus TAA |
| 32-byte `max_color_attachment_bytes_per_sample` floor | Helio's 8 targets cost 48 bytes/sample. G-buffer pipeline creation fails on baseline adapters |

Nothing is `#[cfg]`-ed out. Quality presets are the only platform difference:

| Quality | Ring (m) | Density mult | Arena (MiB) |
|---|---|---|---|
| Low | 48 | 0.35 | 8 |
| Medium | 128 | 1.0 | 64 |
| High | 176 | 1.35 | 128 |
| Ultra | 256 | 2.0 | 256 |

---

## The Seed

Every blade carries a 16-bit seed derived from `hash(tile_coord, lane, generation)`. Dithered LOD cross-fades, wind phase offset, per-blade variation. All of it keys off this value. It is never derived from frame index, time, or a counter.

The seed is the canary for the entire system. If the seed is stable, every stochastic mechanism is stable. If the seed drifts, everything breaks at once. The deterministic placement test is the first CI gate for any foliage PR. We store the seed at the end of the struct where a future developer adding a field is least likely to displace it.

---

*Helio is open at github.com/Far-Beyond-Pulsar/Helio.*
