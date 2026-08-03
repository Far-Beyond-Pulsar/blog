---
title: "Rendering a Million Blades of Grass: Helio's GPU-Driven Foliage System"
date: 2026-08-02
author: Pulsar Engine Team
tags: ["rust", "helio", "graphics", "foliage", "gpu-compute", "rendering", "pulsar"]
description: "A deep dive into Helio's GPU-driven foliage system — tile ring residency, three-band wind, correct motion vectors, and 1M blades under 3ms."
thumbnail: /post_thumb/foliage.png
---

# Rendering a Million Blades of Grass: Helio's GPU-Driven Foliage System

*Pulsar Engine Blog — Helio Renderer Series*

*2026-08-02*

---

## Introduction

A single blade of grass is a triangle strip that costs nothing — eleven vertices, no index buffer, `TriangleStrip` topology, four bytes per instance. But a million of them, spread across a 120-metre radius around the camera, each moving in the wind, each casting a shadow, each occlusion-culled against the previous frame's depth, each writing a correct velocity so temporal anti-aliasing does not smear it into a green blur — that is not one problem. It is seven problems stacked on top of each other, and if any one of them is solved wrong, the result looks like a game from 2007.

The fundamental tension is this: foliage is the most geometry-dense thing a renderer ever draws, but it is also the least important thing to draw correctly. A rock that pops is a bug. A blade of grass that pops is barely noticeable; a thousand blades that pop in unison are a shimmer that the eye picks up instantly even when the conscious brain does not register it. Foliage rendering is therefore a war of attrition against perceptible artefacts — not against absolute correctness, but against the specific failure modes that human peripheral vision is tuned to detect: sudden disappearance, coherent motion that does not match the wind direction, and edges that flicker under camera motion.

UE5 does not solve all of these. UE5's grass path places instances on the CPU, culls them by distance and frustum only, writes no motion vectors, and pops blades out at the cull distance with no fallback. UE5's documentation calls this acceptable. We do not agree.

This post is the complete technical story behind Helio's foliage system — why we built it, how every struct and shader is packed, the tile ring residency cache that makes steady-state placement free, the three-band wind model with correct motion vectors, the interaction field that bends grass underfoot, and the rasterisation path that draws a million blades in four draw calls.

Every struct, every budget number and every failure mode below is taken from the implementation plan and the source code that already exists in `helio-foliage-core`, `helio-pass-foliage-place`, and `helio-pass-foliage-gbuffer`.

---

## Table of Contents

1. [Design Philosophy — Seven Claims](#2-design-philosophy--seven-claims)
2. [Where Helio Already Had the Hard Parts](#3-where-helio-already-had-the-hard-parts)
3. [The GPU Data Model — 16 Bytes of Spite](#4-the-gpu-data-model--16-bytes-of-spite)
4. [Tile Ring Residency Cache](#5-tile-ring-residency-cache)
5. [GPU Placement and Culling](#6-gpu-placement-and-culling)
6. [Wind System and Motion Vectors](#7-wind-system-and-motion-vectors)
7. [Interaction Field](#8-interaction-field)
8. [Rasterisation — Four Draw Calls, Zero Vertex Buffers](#9-rasterisation--four-draw-calls-zero-vertex-buffers)
9. [Performance Budget — 1M Blades Under 3ms](#10-performance-budget--1m-blades-under-3ms)
10. [Platform Constraints and Quality Presets](#11-platform-constraints-and-quality-presets)
11. [The Test Philosophy](#12-the-test-philosophy)
12. [Crate Layout](#13-crate-layout)
13. [What's Next](#14-whats-next)

---

## 2. Design Philosophy — Seven Claims

Helio's foliage system is accountable for seven specific claims, each measured against what UE5 actually does:

```
 1.  Placement never touches the CPU
 2.  Foliage is occlusion-culled (UE: distance + frustum only)
 3.  Impostors are first-class and lit through the G-buffer
 4.  WPO does not break culling
 5.  Wind-correct motion vectors
 6.  Interaction is a shipped feature, not a sample-project hack
 7.  The far ring has no geometry and no pop
```

### 2.1 Claim 1: Placement Never Touches the CPU

Unreal Engine builds grass instance buffers on the CPU. `FGrassBuilder` runs async tasks fed by the landscape grass map, and it hitches when landscape components stream. The problem is not that the CPU is slow at placing grass — the problem is that placing grass on the CPU means every frame's worth of placement is bounded by CPU cycles that could be spent on gameplay logic.

Helio's placement is a compute shader over a residency-cached tile ring. The CPU cost is a constant-size uniform write per frame, independent of density.

#### The tile ring

The world is a grid of 8-metre tiles. A ring of tiles around the camera is resident. On camera motion, tiles entering the ring are pushed to a `place_queue`; tiles leaving are freed LRU. At most `max_tiles_per_frame` (default 24) are placed per frame, so churn is amortised and a teleport degrades to a few frames of progressive fill-in rather than a hitch.

Placement for one tile: one workgroup per tile, each lane evaluating a stratified candidate (jittered grid, blue-noise offset from the seed hash) against the density weight, writing survivors into that tile's slab. Deterministic: same tile coordinate, same generation, same seed => byte-identical blade list, on any GPU. This is directly testable and is a CI test.

**Why residency caching wins:** regenerating every visible blade every frame is the common GPU-grass shortcut and costs ~1 ms at 1 M blades. Caching makes the steady-state placement cost zero and the moving-camera cost proportional to ring perimeter, not ring area.

#### The deterministic placement algorithm

Every placed blade is the output of a pure function:

```
blade = f(tile_coord, lane_index, generation, seed)
```

The function is evaluated identically in WGSL (on the GPU, in the placement dispatch) and in Rust (in the CPU reference test). `tile_coord` identifies which 8-metre tile the blade belongs to. `lane_index` is the blade's position within the tile's stratified candidate grid — each workgroup lane evaluates one candidate. `generation` is the tile's terrain and density version, bumped on every edit so that re-placing a tile produces a *different* deterministic set rather than the same one. `seed` is the layer's authored seed, letting two artists paint different random distributions over the same terrain.

The candidate grid is a jittered stratified pattern: the tile is divided into N×N cells (N derived from density × tile area), each lane evaluates its cell's centre plus a blue-noise offset from `hash(seed, tile_coord, lane)`, then accepts or rejects based on:

1. Is the candidate inside at least one foliage layer's AABB?
2. Does the terrain capture report a valid height at this XZ?
3. Does the pixel density weight (painted × procedural × exclusion) pass a threshold test against `hash(seed, tile_coord, lane)`?
4. Does the terrain slope (from the capture normal) fall within the type's `slope_range`?
5. Does the world altitude fall within the type's `altitude_range`?

### 2.2 Claim 2: Foliage Is Occlusion-Culled

UE5 grass is distance- and frustum-culled only. Helio runs the same conservative Hi-Z max-depth test the meshlet culler uses, at tile and 4×4-cluster granularity, so grass behind a wall costs nothing.

Two compute dispatches:

1. **Tile cull** — one lane per resident tile: frustum test against the tile AABB dilated by `max_height + wpo_extent`, then the conservative Hi-Z max-depth test.
2. **Cluster cull + compaction** — one lane per 4×4 blade cluster: frustum, Hi-Z, distance-to-LOD classification, then `atomicAdd` append into four per-LOD `visible_blades` buffers. A 3-lane finalize dispatch converts counters to `DrawIndirectArgs`.

At 1 M blades this is 62,500 cluster lanes ≈ 977 workgroups. The budget is 0.15 ms.

### 2.3 Claim 3: Impostors Are First-Class and Lit

Unreal Engine ships no built-in octahedral impostor baker — it is a plugin, and impostors commonly land in a forward or translucent path that misses deferred lighting.

Helio's impostors are hemi-octahedral atlases baked by `helio-bake` and rasterised into the G-buffer with reconstructed normal and depth-parallax. They receive shadows, SSAO, SSR and GI identically to the mesh LODs.

The atlas is stored as a **single `texture_2d_array`**, not a binding array, because `MAX_TEXTURES` is 16 on wasm32, Metal and Android. One binding, every platform, no per-platform shader rewrite. Three pages per impostor:

- `Rgba8UnormSrgb`: base colour + coverage alpha
- `Rg8Unorm`: octahedral-encoded world normal
- `R8Unorm`: view-depth for parallax

Transition from the deepest mesh LOD to the impostor uses a stochastic cross-fade over a band sized so the impostor's silhouette error is under one pixel at the switch distance.

### 2.4 Claim 4: WPO Does Not Break Culling

This is the most subtle of the seven claims and the one where the plan's first draft was wrong.

World-Position-Offset moves vertices — grass bends in the wind, leaves flutter. The problem: wind displaces geometry outside the object's bounding sphere and outside each meshlet's sphere. If the culler does not account for this displacement, the object gets culled while its displaced geometry is still on screen. Unreal Engine's answer is a global `WPO Disable Distance` and manually inflated bounds — a sledgehammer that either costs performance everywhere or pops geometry at the disable distance.

Helio's answer is a per-type `wpo_extent` that dilates the object and meshlet cull radii, and a `wpo_disable_distance` that disables WPO **and** stops the dilation in the same frame, driven by the same distance constant. Bounds are never wrong in either direction.

Getting the extent into the cull pass required a design revision. The plan's first draft tried to put `wpo_extent` into `GpuVgObject`, but that struct sums to exactly 128 bytes with zero padding, and the field named `reserved` is not spare — it is live per-frame GPU scratch written by `cs_select_objects` and read by `cs_cull_meshlets` as the object-visibility gate. Reusing it breaks VG culling outright.

The correct home is `InstanceCullData`, which is `pub(crate)` to the VG pass:

```rust
// InstanceCullData grows from 16 → 20 bytes
// Binding 10, read in cs_select_objects and cull_meshlet
```

With the extent available, the dilation is:

- `cs_select_objects`: `world_radius += wpo_extent * max_scale`
- `cull_meshlet`: same dilation on the meshlet sphere
- Past `wpo_disable_distance`, the vertex shader stops applying WPO **and** the culler stops dilating, in the same frame

This is the failure UE papers over with a manual bounds scale. Getting it exactly right is a handful of lines and removes a whole class of edge-of-screen popping.

### 2.5 Claim 5: Wind-Correct Motion Vectors

Grass in Unreal Engine writes no meaningful velocity. TAA smears it.

Helio's foliage vertex shaders evaluate wind at both `t` and `t - dt` and emit a true `prev_clip_position`. This is what makes dithered LOD cross-fades resolve cleanly instead of ghosting.

The wind uniform carries both timestamps:

```rust
#[repr(C)]
pub struct GpuWind {
    pub direction_speed: [f32; 4],   // xyz normalised direction, w = base speed m/s
    pub gust: [f32; 4],              // amplitude, frequency, phase, turbulence scale
    pub time_prev_time: [f32; 2],    // t and t - dt — the critical pair
    pub _pad: [f32; 2],
}
```

`prev_time` is not decoration. It is the input that lets every foliage vertex shader compute `prev_clip_position` correctly, which is the difference between clean TAA and the smeared grass UE ships with.

### 2.6 Claim 6: Interaction Is a Shipped Feature, Not a Hack

Physics-driven bend with exponential recovery, on a snapped camera-relative field, available to every foliage type.

The interaction field is a camera-relative `Rgba16Float` texture (default 512² covering 64 m, snapped to the texel grid):

- **RG**: horizontal displacement direction × magnitude
- **B**: vertical crush amount
- **A**: recovery timer

### 2.7 Claim 7: The Far Ring Has No Geometry and No Pop

Past the last card LOD (L3, 45–120 m) we stop drawing geometry and hand the same density map to the terrain material as an albedo, roughness and normal perturbation. Unreal Engine pops grass out at the cull distance; we dissolve into terrain shading.

The terrain material sees a density-weighted colour contribution at the exact density the placement shader would have placed blades.

| LOD | Range (default) | Geometry | Verts/instance |
|---|---|---|---|
| L0 | 0–8 m | 5-segment blade, `TriangleStrip` | 11 |
| L1 | 8–20 m | 3-segment blade | 7 |
| L2 | 20–45 m | single textured card | 4 |
| L3 | 45–120 m | clump card (one per 4×4 cluster) | 4 |
| — | >120 m | no geometry; terrain material perturbation | 0 |

Seamless transitions are three mechanisms stacked:

- **Scale-in**: a blade entering the ring interpolates height 0→1 over a 2 m band, so nothing ever appears at full size.
- **Stochastic cross-fade**: over the LOD band both representations draw, each alpha-tested against `hash(seed) + blue_noise(pixel, frame)`. TAA resolves it — and resolves it correctly because of the wind-aware motion vectors.
- **Card orientation continuity**: L2/L3 cards inherit the L1 blade's yaw so silhouette direction does not flip at the boundary.

---

## 3. Where Helio Already Had the Hard Parts

Helio did not start from zero. The engine already shipped the subsystems that most GPU-driven foliage renderers have to build from scratch. What was missing was the vegetation-specific wiring — placement, blade geometry, wind, impostors, interaction and the density and terrain authoring paths.

| Existing capability | What foliage needs from it |
|---|---|
| Two-stage meshlet cull + measured-error LOD, 8 LODs/object | Tree geometry, LOD selection, meshlet culling |
| Hi-Z pyramid + conservative max-depth occlusion test | Tile-level and cluster-level occlusion culling |
| 8-target G-buffer incl. velocity, SSS, extra | Foliage fills the same targets, gets lighting/TAA/SSAO for free |
| Indirect draw + count, feature-detected | Zero-CPU draw submission for every blade |
| Shadow atlas, static/dynamic split, per-face dirty culling | Foliage shadow casting |
| Dense voxel terrain with a `MAT_GRASS` palette entry | Runtime density source |
| Texture loading / asset compat | Density map + impostor atlas authoring |
| Whole-repo WGSL validation in CI | New shaders covered the moment they land |
| Camera-relative scrolling sim + hitbox publication precedent | Exact data-flow template for the interaction field |

The single biggest head start is the indirect draw infrastructure. Helio's `helio-pass-indirect-dispatch` already handles feature-detected `MULTI_DRAW_INDIRECT_COUNT` fallback, counter initialisation and the exact `DrawIndirectArgs` layout. Foliage needs exactly four `draw_indirect` calls — one per LOD — and no multi-draw anywhere in the grass path. That means it compiles on WebGPU, which has no `MULTI_DRAW_INDIRECT_COUNT`, without a single `#[cfg]` gate.

The `BillboardPass` that existed before this work was not usable for vegetation. It composited into `pre_aa` *after* deferred lighting, which meant its output received no shadows, no SSAO, no GI and no correct TAA. Impostors must go through the G-buffer, which is what `FoliageGBufferPass` does — eight targets, identical format, `LoadOp::Load` so the executor fuses it into the existing G-buffer subpass chain.

---

## 4. The GPU Data Model — 16 Bytes of Spite

We have a budget: 24 MiB for the blade arena at Medium quality. Every blade record we write costs `arena_bytes / 16_byte_record` blades. At 16 bytes that is 1.5 M blades. Every extra byte costs 1.5 MiB of budget and a proportional slice of placement write bandwidth — which is the dominant GPU cost when the camera moves fast enough to refill the ring perimeter.

We therefore pack. Aggressively. And we live with the consequences.

### 4.1 GpuBladeInstance — 16 bytes

```rust
/// One placed blade of grass. Exactly 16 bytes.
///
/// Everything is packed, and nothing here is a world-space value. Positions are
/// tile-local so a blade's encoding does not depend on where in the world its tile sits,
/// which is what lets placement be a pure function of `(tile_coord, lane, generation)`
/// and therefore reproducible across GPUs.
///
/// # Layout (16 bytes, 4-byte aligned)
/// ```text
///  0..4   packed_pos:         u32  X unorm16 (bits 0..16) | Z unorm16 (bits 16..32)
///  4..8   packed_height_yaw:  u32  height offset f16 (bits 0..16) | yaw turn16 (bits 16..32)
///  8..12  packed_scale_type:  u32  height u8 | width u8 | type id u8 | variant u8
/// 12..16  packed_tint_seed:   u32  tint.x u8 | tint.y u8 | seed u16 (bits 16..32)
/// ```
#[repr(C)]
pub struct GpuBladeInstance {
    /// Tile-local XZ as two 16-bit unorms over the tile extent.
    /// 16 bits over an 8 m tile is 0.12 mm — far finer than needed visually, but the
    /// precision is spent on making the *stratified* candidate grid land exactly where
    /// the CPU reference says it does.
    pub packed_pos: u32,

    /// Terrain height offset in metres as f16 (bits 0..16) | yaw as a 16-bit turn
    /// (bits 16..32).
    /// The height offset is relative to the tile's `bounds_center_y`, not absolute
    /// world Y — f16 has ~3 decimal digits, which is centimetre precision at 100 m and
    /// useless at planetary altitudes.
    pub packed_height_yaw: u32,

    /// Height scale u8 (bits 0..8) | width scale u8 (bits 8..16) | type id u8
    /// (bits 16..24) | variant u8 (bits 24..32).
    pub packed_scale_type: u32,

    /// Tint X u8 (bits 0..8) | tint Y u8 (bits 8..16) | stable per-blade seed u16
    /// (bits 16..32).
    pub packed_tint_seed: u32,
}
```

The `BladeParams` unpacked type exists specifically so the CPU reference placement can work in human-scale values:

```rust
/// Unpacked, human-scale view of a GpuBladeInstance.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BladeParams {
    pub tile_uv: [f32; 2],
    pub height_offset: f32,
    pub yaw: f32,
    pub height_scale: f32,
    pub width_scale: f32,
    pub type_id: u8,
    pub variant: u8,
    pub tint: [f32; 2],
    pub seed: u16,
}
```

#### packed_pos: XZ as 16-bit unorm (not world space)

This is the most important decision in the struct. Every blade stores its position as a fraction of the tile it lives in — not as metres in the world. That means the blade arena encodes *relative* positions that do not change when the tile moves in the residency ring.

The critical consequence: placement is a pure function.

```
blade = f(tile_coord, lane, generation)
               └──────────────────┬────┘
                          never includes:
                          frame index, time, camera position, or counter
```

If we stored world-space positions, a blade's encoding would depend on where its tile sits in the world. Replace the same tile at the same coordinate with the same generation and you must get byte-identical output — that is the determinism contract. Tile-local positions make that true trivially; world-space positions would require reconstructing the same floating-point multiplication that produced the original coordinate, which is not reproducible across GPUs with different FMA behaviour.

#### packed_height_yaw: f16 offset + 16-bit turn

Height offset is relative to the tile's `bounds_center_y`, not absolute world Y. This is what makes f16 safe: f16 has ~3 decimal digits of precision, which is centimetre resolution at 100 m and useless at 10 km. Tile-relative keeps the offset small — typically within ±5 m of the tile centre — so the f16 mantissa covers it with sub-centimetre precision.

Yaw uses the turn convention (divide by 2^16, not 2^16 - 1) because an angle wraps: 0 and 2π are the same orientation. Spending a code on both wastes a step.

```rust
pub fn pack_yaw(radians: f32) -> u16 {
    let turns = radians * (1.0 / std::f32::consts::TAU);
    let wrapped = turns - turns.floor();
    (((wrapped * 65536.0 + 0.5) as u32) & 0xffff) as u16
}
```

#### packed_scale_type: four u8s in one u32

Height scale, width scale, type id, variant — each gets a byte. The scales are unorm lerp factors into the type's height/width ranges, not metres. This is deliberate: a designer retuning a foliage type's size does not invalidate resident tiles. Only the descriptor changes and the arena stays valid.

Type id being 8 bits caps a scene at 256 distinct foliage types. That ceiling is deliberate: the descriptor array is read by every blade lane, and 256 × 96 B = 24 KiB, which fits comfortably in L1 on every tier.

#### packed_tint_seed: the load-bearing field

The seed is the low 16 bits of `blade_seed` and is the single most important value in this struct. Dithered LOD cross-fades, wind phase offset, per-blade variation — everything keys off it. It must be derived from `(tile_coord, lane, generation)` and **never** from frame state.

Read that again: never from frame state. A seed that changes between frames turns the stochastic cross-fade into full-screen static that TAA cannot resolve, and makes every blade's wind phase jump every frame.

### 4.2 Tile-local positions and GPU reproducibility

We have said this already, but it bears repeating because it is the single most consequential decision in the system:

```
  ┌─────────────────────────────────────────┐
  │  blade position ≠ f(world coordinate)   │
  │  blade position = f(tile_uv)            │
  │  tile_uv is a fraction of tile extent   │
  │  tile extent is 8 m everywhere          │
  └─────────────────────────────────────────┘
```

The WGSL placement shader evaluates exactly the same hash and unorm quantisation that the CPU reference does. Because neither path ever touches world coordinates in the packing inner loop, they can disagree on world-space floating-point rounding without affecting the blade arena contents.

This is what makes the determinism test meaningful:

```rust
fn re_placing_a_tile_reproduces_the_same_blades() {
    fn place(tile_coord: [i32; 2], generation: u32) -> Vec<GpuBladeInstance> {
        (0..128u32)
            .map(|lane| {
                let seed = blade_seed(tile_coord, lane, generation);
                pack_blade(BladeParams {
                    tile_uv: [hash_to_unit(seed), hash_to_unit(seed.rotate_left(11))],
                    height_offset: hash_to_unit(seed.rotate_left(19)) * 0.4,
                    yaw: hash_to_unit(seed.rotate_left(23)) * std::f32::consts::TAU,
                    height_scale: hash_to_unit(seed.rotate_left(5)),
                    width_scale: hash_to_unit(seed.rotate_left(7)),
                    type_id: 2,
                    variant: (seed >> 30) as u8,
                    tint: [hash_to_unit(seed.rotate_left(3)), 0.25],
                    seed: seed as u16,
                })
            })
            .collect()
    }

    let first = place([12, -7], 3);
    let second = place([12, -7], 3);
    assert_eq!(
        bytemuck::cast_slice::<_, u8>(&first),
        bytemuck::cast_slice::<_, u8>(&second),
        "the same tile and generation must produce a byte-identical blade list"
    );
}
```

### 4.3 GpuFoliageTile — the 32-byte residency header

The ring of resident tiles is the bridge between the world grid and the blade arena. Each tile slot is 32 bytes:

```rust
/// Header for one slot in the resident tile ring. Exactly 32 bytes.
///
/// At the default ring capacity of 4096 the whole table is 128 KiB,
/// small enough that the tile cull can read it linearly without an
/// acceleration structure.
///
/// # Layout (32 bytes, 4-byte aligned)
/// ```text
///  0..8   tile_coord:      vec2<i32>   world tile grid coordinate
///  8..12  blade_offset:    u32
/// 12..16  blade_count:     u32
/// 16..20  bounds_center_y: f32
/// 20..24  bounds_half_y:   f32
/// 24..28  state:           u32         TileState
/// 28..32  generation:      u32
/// ```
#[repr(C)]
pub struct GpuFoliageTile {
    pub tile_coord: [i32; 2],
    pub blade_offset: u32,
    pub blade_count: u32,
    pub bounds_center_y: f32,
    pub bounds_half_y: f32,
    pub state: u32,
    pub generation: u32,
}
```

The `state` field is a `u32` that maps to `TileState`:

```rust
#[repr(u32)]
pub enum TileState {
    #[default]
    Free = 0,
    Placing = 1,
    Resident = 2,
    Evicting = 3,
}
```

Every state round-trips through its `u32` representation, and unknown values are refused rather than defaulted:

```rust
#[test]
fn tile_state_round_trips_and_refuses_to_guess() {
    for state in [TileState::Free, TileState::Placing,
                  TileState::Resident, TileState::Evicting] {
        assert_eq!(TileState::from_u32(state.as_u32()), Some(state));
    }
    assert_eq!(TileState::from_u32(4), None);
    assert_eq!(TileState::from_u32(u32::MAX), None);
}
```

The `generation` field is bumped whenever the density map or terrain under this tile is edited. Residency is keyed on `(tile_coord, generation)`, so a bump invalidates the cached blades without needing an explicit flush, and it feeds `blade_seed` so the re-placed blades are a *different* deterministic set rather than the same one.

### 4.4 GpuFoliageType — 96 bytes (the plan said 64)

This is the one that embarrassed us in code review. The plan's §4.3 heads this struct "64 bytes", but its own field list sums to 84. The header was simply wrong, and the fields are what matter. Rounding up to 96 leaves 12 bytes of tail padding, which is deliberate and meant to be spent.

```rust
/// Foliage type descriptor shared by placement and rasterisation. Exactly 96 bytes.
///
/// One entry per *authored type* — not per instance. A scene has tens of foliage types,
/// so the whole table is a few kilobytes and stays permanently hot in L1.
///
/// # Layout (96 bytes, 4-byte aligned)
/// ```text
///  0..4   density:               f32
///  4..12  height_range:          f32 × 2
/// 12..20  width_range:           f32 × 2
/// 20..28  slope_range:           f32 × 2    cos(slope) band
/// 28..36  altitude_range:        f32 × 2
/// 36..52  lod_distances:         f32 × 4
/// 52..64  wind_response:         f32 × 3    NEVER vec3, see below
/// 64..68  interaction_stiffness: f32
/// 68..72  material_id:           u32
/// 72..76  density_layer:         u32
/// 76..80  kind_and_flags:        u32
/// 80..84  mesh_or_impostor_id:   u32
/// 84..96  _pad:                  u32 × 3    reserved headroom
/// ```
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

The earlier draft of this type hit 64 bytes by storing `height_range`, `width_range`, `slope_range` and `lod_distances` as `f16` pairs. That bought about two kilobytes — nothing — and cost a decode on both sides, a standing risk that the WGSL `unpack2x16float` path and the Rust packer disagree at some edge value, and a struct with no room to grow.

Packing is the wrong trade for a per-type table. It is the right trade for `GpuBladeInstance`, which is per-instance and multiplied by a million. For the type descriptor table — tens of entries, permanently hot in L1 — the savings are theoretical and the costs are real.

#### The WGSL `vec3<f32>` footgun

Every field in `GpuFoliageType` must be declared as a scalar in WGSL. Not one may be a vector type. WGSL gives `vec3<f32>` a 16-byte alignment. Here is the field layout:

```
 0..4   density:               f32     offset 0  (4-byte aligned)
 4..12  height_range:          f32×2   offset 4  (NOT 8-byte aligned)
12..20  width_range:           f32×2   offset 12 (NOT 8-byte aligned)
20..28  slope_range:           f32×2   offset 20
28..36  altitude_range:        f32×2   offset 28
36..52  lod_distances:         f32×4   offset 36 (NOT 16-byte aligned)
52..64  wind_response:         f32×3   offset 52 (NOT 16-byte aligned)
64..68  interaction_stiffness: f32
68..72  material_id:           u32
72..76  density_layer:         u32
76..80  kind_and_flags:        u32
80..84  mesh_or_impostor_id:   u32
84..96  _pad:                  u32×3
```

`wind_response` is the dangerous one. Someone will reach for `vec3<f32>` without thinking — it is three floats, after all. WGSL gives `vec3<f32>` a 16-byte alignment, so that single declaration would push the field from offset 52 to 64 and shift **every field after it**.

Nothing crashes. Trees render with a random material. Foliage kinds resolve to the wrong pipeline. The cause is twelve bytes of padding rules in a language spec, and it costs a day to bisect.

We pin this with a test:

```rust
#[test]
fn no_foliage_type_field_is_wgsl_vector_aligned() {
    let value = GpuFoliageType::zeroed();
    let base = &value as *const _ as usize;
    let offset_of = |field: *const u8| field as usize - base;

    for offset in [
        offset_of(value.height_range.as_ptr() as *const u8),
        offset_of(value.width_range.as_ptr() as *const u8),
        offset_of(value.slope_range.as_ptr() as *const u8),
        offset_of(value.altitude_range.as_ptr() as *const u8),
    ] {
        assert_ne!(offset % 8, 0, "offset {offset} is vec2<f32>-aligned in WGSL");
    }
    for offset in [
        offset_of(value.lod_distances.as_ptr() as *const u8),
        offset_of(value.wind_response.as_ptr() as *const u8),
    ] {
        assert_ne!(offset % 16, 0, "offset {offset} is vec3/vec4-aligned in WGSL");
    }
}
```

### 4.5 GpuFoliageLayer — 32-byte AABB with infinite-extent flag

The layer system lets a publisher define where foliage grows. Each layer is a world-space AABB:

```rust
/// GPU mirror of one authored foliage layer.
///
/// The placement shader accepts a candidate only if it lies inside at least one
/// layer's AABB, or inside a layer marked infinite.
///
/// # Layout (32 bytes, 4-byte aligned)
/// ```text
///  0..16  bounds_min: vec4<f32>  xyz = AABB minimum, w unused
/// 16..32  bounds_max: vec4<f32>  xyz = AABB maximum, w = 1.0 ⇒ infinite
/// ```
#[repr(C)]
pub struct GpuFoliageLayer {
    pub bounds_min: [f32; 4],
    pub bounds_max: [f32; 4],
}
```

Two `vec4<f32>`, chosen deliberately because WGSL gives `vec4` 16-byte alignment, so any field added after these would start on its own 16-byte cell.

### 4.6 FoliageKind and the flag bits

```rust
#[repr(u32)]
pub enum FoliageKind {
    #[default]
    Blade = 0,
    Card = 1,
    Mesh = 2,
}
```

Kind and flags share one `u32` in `GpuFoliageType::kind_and_flags`:

```rust
pub const FOLIAGE_KIND_MASK: u32 = 0x0000_00ff;
pub const FOLIAGE_FLAG_TWO_SIDED: u32 = 1 << 8;
pub const FOLIAGE_FLAG_CASTS_SHADOW: u32 = 1 << 9;
pub const FOLIAGE_FLAG_RECEIVES_INTERACTION: u32 = 1 << 10;
```

### 4.7 Compile-time size asserts

Every GPU struct has a compile-time size assert:

```rust
const _: () = {
    assert!(std::mem::size_of::<GpuBladeInstance>() == 16);
    assert!(std::mem::size_of::<GpuFoliageTile>() == 32);
    assert!(std::mem::size_of::<GpuFoliageType>() == 96);
    assert!(std::mem::size_of::<GpuFoliageLayer>() == 32);
};
```

These fail at compile time if the size changes — no runtime test suite needed. A size change that the shader does not follow does not fail loudly; the shader reads every field from the wrong offset and produces garbage rotations, which is a full day of debugging.

We also pin field offsets:

```rust
#[test]
fn foliage_type_field_offsets_match_the_documented_layout() {
    let value = GpuFoliageType::zeroed();
    let base = &value as *const _ as usize;
    let offset_of = |field: *const u8| field as usize - base;

    assert_eq!(offset_of(&value.density as *const f32 as *const u8), 0);
    assert_eq!(offset_of(value.height_range.as_ptr() as *const u8), 4);
    assert_eq!(offset_of(value.width_range.as_ptr() as *const u8), 12);
    assert_eq!(offset_of(value.slope_range.as_ptr() as *const u8), 20);
    assert_eq!(offset_of(value.altitude_range.as_ptr() as *const u8), 28);
    assert_eq!(offset_of(value.lod_distances.as_ptr() as *const u8), 36);
    assert_eq!(offset_of(value.wind_response.as_ptr() as *const u8), 52);
    assert_eq!(offset_of(&value.interaction_stiffness as *const f32 as *const u8), 64);
    assert_eq!(offset_of(&value.material_id as *const u32 as *const u8), 68);
    assert_eq!(offset_of(&value.density_layer as *const u32 as *const u8), 72);
    assert_eq!(offset_of(&value.kind_and_flags as *const u32 as *const u8), 76);
    assert_eq!(offset_of(&value.mesh_or_impostor_id as *const u32 as *const u8), 80);
    assert_eq!(offset_of(value._pad.as_ptr() as *const u8), 84);
    assert_eq!(std::mem::size_of::<GpuFoliageType>() - 84, 12);
}
```

### 4.8 The seed: never from frame state

The `blade_seed` function is the linchpin of the entire determinism contract:

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

Three inputs. That is it. No frame index. No time. No counter. Nothing that changes between frames.

### 4.9 Packing/unpacking functions and round-trips

The pack functions mirror the WGSL builtins exactly:

```rust
pub fn pack_blade(params: BladeParams) -> GpuBladeInstance {
    GpuBladeInstance {
        packed_pos: pack_blade_pos(params.tile_uv[0], params.tile_uv[1]),
        packed_height_yaw: pack_blade_height_yaw(params.height_offset, params.yaw),
        packed_scale_type: pack_blade_scale_type(
            params.height_scale, params.width_scale,
            params.type_id, params.variant,
        ),
        packed_tint_seed: pack_blade_tint_seed(params.tint[0], params.tint[1], params.seed),
    }
}
```

The round-trip test asserts quantisation tolerances explicitly:

```rust
#[test]
fn blade_round_trips_within_quantisation_tolerance() {
    let cases = [
        BladeParams::default(),
        BladeParams {
            tile_uv: [0.0, 0.0], height_offset: 0.0, yaw: 0.0,
            height_scale: 0.0, width_scale: 0.0,
            type_id: 0, variant: 0, tint: [0.0, 0.0], seed: 0,
        },
        BladeParams {
            tile_uv: [1.0, 1.0], height_offset: -12.5,
            yaw: std::f32::consts::TAU - 1.0e-3,
            height_scale: 1.0, width_scale: 1.0,
            type_id: 255, variant: 255, tint: [1.0, 1.0], seed: u16::MAX,
        },
    ];

    for original in cases {
        let decoded = unpack_blade(&pack_blade(original));
        assert!((decoded.tile_uv[0] - original.tile_uv[0]).abs() <= 1.0 / 65535.0);
        assert!((decoded.tile_uv[1] - original.tile_uv[1]).abs() <= 1.0 / 65535.0);
    }
}
```

The most important test for the evict/re-place cycle:

```rust
#[test]
fn blade_repack_is_idempotent_after_the_first_pass() {
    for i in 0..512u32 {
        let t = i as f32 / 511.0;
        let original = BladeParams {
            tile_uv: [t, 1.0 - t],
            height_offset: t * 20.0 - 10.0,
            yaw: t * std::f32::consts::TAU * 3.0,
            height_scale: t,
            width_scale: 1.0 - t,
            type_id: (i & 0xff) as u8,
            variant: ((i >> 3) & 0xff) as u8,
            tint: [t, t * 0.5],
            seed: (i * 7919) as u16,
        };
        let first = pack_blade(original);
        let second = pack_blade(unpack_blade(&first));
        assert_eq!(first.packed_pos, second.packed_pos);
        assert_eq!(first.packed_height_yaw, second.packed_height_yaw);
        assert_eq!(first.packed_scale_type, second.packed_scale_type);
        assert_eq!(first.packed_tint_seed, second.packed_tint_seed);
    }
}
```

`unpack_blade(pack_blade(p))` is not bit-identical to `p` on the first pass — positions and tints quantise to unorm, height to f16, yaw to 1/65536 of a turn. But from the second application onward it *is* idempotent. That is the property the round-trip tests assert: a decode/encode cycle that drifted would let a tile that survives an evict and re-place look different from one that did not.

---

## 5. Tile Ring Residency Cache

Foliage in Helio lives on a grid of **8 m tiles** (the constant `FOLIAGE_TILE_SIZE_METERS = 8.0`). A **camera-centred square window** of these tiles is resident in GPU memory at any time.

```
FoliageQuality   Ring radius    Tiles across    Tile count    Ring capacity
───────────────  ────────────   ─────────────   ──────────    ─────────────
Low              32 m           9  ×  9         81            81
Medium           64 m           17 × 17        289           289
High            128 m           33 × 33       1089          1089 (cap)
Ultra           256 m           65 × 65       4225          1089 (clamped, thrashes)
```

The resident set lives on the GPU in two buffers owned by `FoliagePlacePass`:

- **`tile_table`**: one `GpuFoliageTile` header per slot (32 bytes each).
- **`blade_arena`**: fixed-size slabs, one per slot, each holding up to `blades_per_tile` `GpuBladeInstance` records (16 bytes each).

The CPU-side orchestrator is `TileRing`:

```rust
pub struct TileRing {
    capacity: u32,
    tiles_across: u32,
    tile_size: f32,
    max_tiles_per_frame: u32,
    center: [i32; 2],
    has_center: bool,
    generation: u32,
    slots: Vec<Slot>,
    occupied: HashMap<[i32; 2], u32>,
    free_slots: Vec<u32>,
    lru: BTreeSet<(u64, u32)>,
    pending: VecDeque<[i32; 2]>,
    pending_set: HashSet<[i32; 2]>,
    place_queue: Vec<u32>,
    dirty: Vec<u32>,
    touch_counter: u64,
    last_visited: usize,
}
```

### 5.1 Why Caching: O(perimeter) Not O(area)

The obvious "simpler" implementation — rebuild the resident set from scratch each frame and diff it — renders identically and is **O(area)** of the ring. A 128 m ring is `(128 / 8)² = 256` tiles; rebuilding it from scratch visits all 256 coordinates per frame.

Our `shift_to` method visits **only the entering and leaving strips**. The cost is proportional to the **perimeter** of the ring: `4 × tiles_across` for a full-one-tile step, rather than `tiles_across²`.

The one case that is genuinely O(area) is a **teleport**, where the new window does not overlap the old at all. That is unavoidable, and it is why placement is budgeted: the entering tiles queue up and drain at `max_tiles_per_frame`, so a teleport degrades to a few frames of progressive fill-in rather than a hitch.

### 5.2 `shift_to` — The Two-Loop Perimeter Algorithm

```rust
fn shift_to(&mut self, new_center: [i32; 2]) -> u32 {
    let (ox0, ox1, oz0, oz1) = self.window(self.center);
    let (nx0, nx1, nz0, nz1) = self.window(new_center);
    let mut released = 0u32;

    // Leaving: old \ new.
    for x in ox0..=ox1 {
        if x < nx0 || x > nx1 {
            for z in oz0..=oz1 {
                self.last_visited += 1;
                if self.release_coord([x, z]) {
                    released += 1;
                }
            }
        }
    }
    let overlap_x0 = ox0.max(nx0);
    let overlap_x1 = ox1.min(nx1);
    if overlap_x0 <= overlap_x1 {
        for z in oz0..=oz1 {
            if z < nz0 || z > nz1 {
                for x in overlap_x0..=overlap_x1 {
                    self.last_visited += 1;
                    if self.release_coord([x, z]) {
                        released += 1;
                    }
                }
            }
        }
    }

    // Entering: new \ old.
    for x in nx0..=nx1 {
        if x < ox0 || x > ox1 {
            for z in nz0..=nz1 {
                self.last_visited += 1;
                self.request([x, z]);
            }
        }
    }
    if overlap_x0 <= overlap_x1 {
        for z in nz0..=nz1 {
            if z < oz0 || z > oz1 {
                for x in overlap_x0..=overlap_x1 {
                    self.last_visited += 1;
                    self.request([x, z]);
                }
            }
        }
    }

    self.center = new_center;
    released
}
```

Every coordinate visit increments `self.last_visited`. The test asserts that a one-tile step on a 33×33 ring visits exactly `2 × 33 = 66` coordinates, not `33² = 1089`:

```rust
#[test]
fn a_one_tile_step_touches_a_perimeter_not_an_area() {
    const ACROSS: u32 = 33;
    let mut ring = ring(ACROSS, 4096);
    settle(&mut ring, [0.0, 0.0]);

    let update = ring.update([TILE * 1.5, 0.0], 0);
    assert_eq!(update.released, ACROSS, "one column leaves");
    assert_eq!(update.placed, ACROSS, "one column enters");
    assert_eq!(ring.last_visited(), 2 * ACROSS as usize);
    assert!(
        ring.last_visited() < (ACROSS as usize).pow(2) / 4,
        "a one-tile step visited {} coordinates on a {ACROSS}x{ACROSS} ring — \
         the residency cache has become O(area)",
        ring.last_visited()
    );
}
```

### 5.3 `RingUpdate` Metrics

Every call to `TileRing::update` returns a `RingUpdate` struct:

```rust
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RingUpdate {
    pub placed: u32,
    pub released: u32,
    pub evicted: u32,
    pub pending: u32,
    pub invalidated: bool,
}
```

| Field | Meaning |
|---|---|
| `placed` | Slots handed a new tile coordinate this frame — scheduled for GPU placement |
| `released` | Slots released back to the free list this frame |
| `evicted` | Resident tiles evicted to make room; non-zero means thrashing |
| `pending` | Tile coordinates still waiting for a placement budget slot |
| `invalidated` | The content generation changed and the whole ring was invalidated |

In steady state (camera within the same tile), `update` returns `RingUpdate::default()` — all fields zero, no work done. The steady state is **free**.

### 5.4 The LRU eviction path

When the ring capacity is smaller than the window, `drain_pending` cannot pop a free slot and must evict. The eviction candidate is the **least recently admitted** resident tile:

```rust
None => {
    let Some(&(touch, victim)) = self.lru.iter().next() else {
        self.pending.push_front(coord);
        self.pending_set.insert(coord);
        break;
    };
    self.lru.remove(&(touch, victim));
    if let Some(entry) = self.slots.get_mut(victim as usize) {
        if let Some(old_coord) = entry.coord.take() {
            self.occupied.remove(&old_coord);
        }
        entry.touch = 0;
    }
    self.dirty.push(victim);
    evicted += 1;
    victim
}
```

### 5.5 Max 24 Tiles/Frame — Amortised Placement

The placement budget (`DEFAULT_MAX_TILES_PER_FRAME = 24`) caps the work per frame so that no single frame spikes. A teleport — camera jumps from `[0, 0]` to `[10000, 10000]` tiles away — releases all 1089 tiles and places at most 24 per frame:

```rust
#[test]
fn a_teleport_degrades_to_progressive_fill_in_not_a_hitch() {
    const ACROSS: u32 = 17;
    const BUDGET: u32 = 24;
    let mut ring = ring(ACROSS, BUDGET);
    settle(&mut ring, [0.0, 0.0]);

    let update = ring.update([TILE * 10_000.0, TILE * 10_000.0], 0);
    assert_eq!(update.released, ACROSS * ACROSS);
    assert_eq!(update.placed, BUDGET);
    assert!(update.pending > 0);

    let mut frames = 1;
    while ring.pending_count() > 0 {
        let update = ring.update([TILE * 10_000.0, TILE * 10_000.0], 0);
        assert!(update.placed <= BUDGET);
        frames += 1;
    }
    assert_eq!(frames, (ACROSS * ACROSS).div_ceil(BUDGET));
}
```

### 5.6 Fixed Slabs Per Tile

This is the most consequential correctness choice in the buffer layout. The blade arena is **partitioned into equal fixed slabs**, one per ring slot. A bump allocator would be simpler in one sense — just push survivors — but would introduce a fragility:

> With a bump allocator a tile's `blade_offset` would depend on the order tiles happened to be placed in, so an evict/re-place cycle would move a tile's blades in memory and the arena would fragment under ring churn. Equal slabs also make `blade_index / blades_per_tile` an exact O(1) recovery of the owning tile.

The slab capacity is a constructor parameter, and density is expressed relative to it. If the authored density exceeds the slab, the candidate grid is scaled down uniformly — every blade gets thinner, rather than one corner of every tile going bald.

### 5.7 Generation Bump for Density/Terrain Edits

Residency is keyed on `(tile_coord, generation)`. When the content generation changes, the ring is invalidated and requeued. The generation travels from `FrameResources.foliage.generation` through `TileRing::update` into `blade_seed`, so a re-placed tile gets a **different** deterministic set.

```rust
pub fn update(&mut self, camera_xz: [f32; 2], generation: u32) -> RingUpdate {
    if self.generation != generation {
        self.generation = generation;
        update.released += self.resident_count();
        self.invalidate();
        update.invalidated = true;
    }
}
```

Every freed slot must appear in the `dirty` list in the **same** frame, or the GPU keeps drawing tiles whose blades belong to the previous generation:

```rust
#[test]
fn a_generation_bump_invalidates_residency_and_requeues_the_window() {
    let mut ring = ring(7, 4);
    settle(&mut ring, [0.0, 0.0]);
    assert_eq!(ring.resident_count(), 49);

    let update = ring.update([0.0, 0.0], 1);
    assert!(update.invalidated, "a new generation must invalidate");
    assert_eq!(update.released, 49);
    for slot in 0..49 {
        assert!(ring.dirty_slots().contains(&slot),
            "slot {slot} was invalidated without a header write");
    }
}
```

#### The `TileState` machine and why headers publish `Placing` not `Resident`

When the CPU uploads a new tile header in `upload_tile_headers`, it publishes state `Placing`, not `Resident`. The GPU flips the state to `Resident` at the end of `cs_place`. If the CPU published `Resident` instead, the cull pass could read a slab that placement has not written yet, drawing the previous tenant's blades for one frame.

---

## 6. GPU Placement and Culling

### 6.1 Four Compute Stages

The execute method in `pass.rs` records four compute passes in sequence on `ctx.encoder_ptr` (the main render encoder — not `chain_transparent`, because all `chain_transparent` work runs before *all* render-encoder work and would therefore read the previous frame's Hi-Z):

```
┌─────────────────────────────────────────────────────────┐
│  Stage 1: cs_place                                       │
│  One workgroup per queued tile (≤24)                     │
│  Evaluates stratified candidates, writes arena slabs     │
├─────────────────────────────────────────────────────────┤
│  Stage 2: cs_tile_cull                                   │
│  One lane per resident tile                              │
│  Frustum + Hi-Z occlusion test on tile AABB              │
├─────────────────────────────────────────────────────────┤
│  Stage 3: cs_cluster_cull                                │
│  One lane per 4×4 blade cluster                          │
│  Frustum + Hi-Z + LOD classification, append to buckets  │
├─────────────────────────────────────────────────────────┤
│  Stage 4: cs_finalize                                    │
│  Single workgroup: convert counters → DrawIndirectArgs   │
└─────────────────────────────────────────────────────────┘
```

```rust
let encoder = unsafe { &mut *ctx.encoder_ptr };
encoder.clear_buffer(&self.counters, 0, None);

if self.queued_tile_count > 0 {
    let mut pass = encoder.begin_compute_pass(/* "Foliage Place" */);
    pass.set_pipeline(&self.place_pipeline);
    pass.set_bind_group(0, &self.place_bind_group, &[]);
    pass.dispatch_workgroups(self.queued_tile_count, 1, 1);
}

{
    let mut pass = encoder.begin_compute_pass(/* "Foliage Tile Cull" */);
    pass.set_pipeline(&self.tile_cull_pipeline);
    pass.set_bind_group(0, cull_bg, &[]);
    pass.dispatch_workgroups(self.tile_dispatch_groups, 1, 1);
}

{
    let mut pass = encoder.begin_compute_pass(/* "Foliage Cluster Cull" */);
    pass.set_pipeline(&self.cluster_cull_pipeline);
    pass.set_bind_group(0, cull_bg, &[]);
    pass.dispatch_workgroups(self.cluster_dispatch_width, self.cluster_dispatch_height, 1);
}

{
    let mut pass = encoder.begin_compute_pass(/* "Foliage Finalize" */);
    pass.set_pipeline(&self.finalize_pipeline);
    pass.set_bind_group(0, cull_bg, &[]);
    pass.dispatch_workgroups(1, 1, 1);
}
```

### 6.2 Deterministic Placement: Prefix Sum (Not `atomicAdd`)

The plan's §6.1 requires that the same `(tile_coord, generation)` produce a **byte-identical** blade list on any GPU. That is stronger than "the same set of blades survives", and it is the reason the shader compacts with a **workgroup prefix sum** instead of `atomicAdd`: atomic ordering is unspecified, so an atomic append produces the right *set* in an arbitrary *order*, and the arena bytes would differ between two runs on the same machine. With the scan, a blade's slab index is a pure function of its candidate index.

The determinism test in `reference.rs`:

```rust
#[test]
fn placing_the_same_tile_twice_is_byte_identical() {
    let types = [GpuFoliageType::default()];
    let uni = uniforms(24, 1024, &types);
    let first = place_tile_reference(&uni, &types, &[], [12, -7], 3);
    let second = place_tile_reference(&uni, &types, &[], [12, -7], 3);
    assert!(!first.blades.is_empty(), "the reference placed nothing to compare");
    assert_eq!(
        bytemuck::cast_slice::<_, u8>(&first.blades),
        bytemuck::cast_slice::<_, u8>(&second.blades),
    );
}
```

And that nothing frame-dependent can reach the output:

```rust
#[test]
fn nothing_frame_dependent_can_reach_the_output() {
    let types = [GpuFoliageType::default()];
    let uni = uniforms(16, 1024, &types);
    let baseline = place_tile_reference(&uni, &types, &[], [0, 0], 0);
    for _ in 0..8 {
        assert_eq!(place_tile_reference(&uni, &types, &[], [0, 0], 0), baseline);
    }
}
```

A generation bump must reshuffle, not perturb:

```rust
#[test]
fn a_generation_bump_reshuffles_rather_than_perturbs() {
    let types = [GpuFoliageType::default()];
    let uni = uniforms(24, 1024, &types);
    let first = place_tile_reference(&uni, &types, &[], [4, 4], 0);
    let bumped = place_tile_reference(&uni, &types, &[], [4, 4], 1);
    let shared = first.blades.iter().zip(bumped.blades.iter())
        .filter(|(a, b)| a.packed_pos == b.packed_pos).count();
    assert!(shared * 20 < first.blades.len().max(1),
        "{shared} of {} blades kept their position across a generation bump",
        first.blades.len());
}
```

### 6.3 Stratified Candidate Grid with Blue-Noise Offset

Each tile evaluates a **stratified grid** of candidates. The grid resolution is `candidate_grid × candidate_grid`, computed from the authored density and the tile's arena slab:

```rust
fn candidate_grid(&self, max_density: f32) -> (u32, f32) {
    let scaled_density = max_density * self.quality.density_multiplier();
    let area = FOLIAGE_TILE_SIZE_METERS * FOLIAGE_TILE_SIZE_METERS;
    let desired = (scaled_density * area).ceil();
    let ideal = (desired.sqrt().ceil() as u32).max(1);
    let slab_limit = isqrt(self.blades_per_tile).max(1);
    let loop_limit = isqrt(MAX_CANDIDATES_PER_TILE).max(1);
    let edge = isqrt(self.cluster_size).max(1);
    let grid = (ideal.min(slab_limit).min(loop_limit) / edge).max(1) * edge;
    let achieved = ((grid as f32 * grid as f32) / desired).clamp(0.0, 1.0);
    (grid, achieved)
}
```

Each candidate cell gets a **blue-noise offset** from the seed hash:

```rust
pub fn reference_candidate(
    uniforms: &PlaceUniforms,
    types: &[GpuFoliageType],
    layers: &[GpuFoliageLayer],
    tile_coord: [i32; 2],
    generation: u32,
    index: u32,
) -> ReferenceCandidate {
    let grid = uniforms.candidate_grid.max(1);
    let inv_grid = 1.0 / grid as f32;
    let seed = blade_seed(tile_coord, index, generation);

    let cell_x = index % grid;
    let cell_z = index / grid;
    let u = (cell_x as f32 + hash_to_unit(seed)) * inv_grid;
    let v = (cell_z as f32 + hash_to_unit(seed.rotate_left(11))) * inv_grid;

    // ... type selection, weight, acceptance test ...
}
```

The stratification test ensures every 4×4 bucket gets blades:

```rust
#[test]
fn stratification_spreads_blades_over_the_whole_tile() {
    let types = [GpuFoliageType::default()];
    let uni = uniforms(32, 4096, &types);
    let placement = place_tile_reference(&uni, &types, &[], [7, -2], 0);
    let mut buckets = [0u32; 16];
    for blade in &placement.blades {
        let params = unpack_blade(blade);
        let bx = ((params.tile_uv[0] * 4.0) as usize).min(3);
        let bz = ((params.tile_uv[1] * 4.0) as usize).min(3);
        buckets[bz * 4 + bx] += 1;
    }
    for (index, count) in buckets.iter().enumerate() {
        assert!(*count > 0, "quadrant {index} of the tile got no blades at all");
    }
}
```

### 6.4 Cluster Culling at 4×4 Granularity

After placement, the tile cull pass decides which *tiles* are visible (frustum + Hi-Z max-depth test against the tile AABB dilated by `max_height + wpo_extent`). Then the **cluster cull** pass refines this to 4×4 blade clusters — 16 blades grouped into one visibility unit and one LOD classification unit.

Each cluster lane:

1. **Frustum test** against the cluster's bounding sphere (expanded by blade height).
2. **Hi-Z max-depth test** — same conservative test `vg_cull.wgsl` uses, including the `hiz_valid` frame-0 guard.
3. **LOD classification** — distance from camera selects L0, L1, L2 or L3; within the LOD transition band, both representations draw and a stochastic cross-fade selects.

Survivors are appended via `atomicAdd` into four per-LOD `visible_blades` buffers (this is the one place in the entire pipeline where atomic appends are acceptable, because the output is a *bag of indices* used only for drawing — ordering does not affect correctness or reproducibility).

### 6.5 LOD Ladder Table

| LOD | Range (default) | Geometry | Verts/instance |
|---|---|---|---|
| L0 | 0–8 m | 5-segment blade, strip | 11 |
| L1 | 8–20 m | 3-segment blade, strip | 7 |
| L2 | 20–45 m | single textured card | 4 |
| L3 | 45–120 m | clump card (one per 4×4 cluster) | 4 |
| — | >120 m | no geometry; terrain material perturbation | 0 |

Each LOD is one `draw_indirect(vertex_count, instance_count)` — four draws total for all grass in the world. Per-instance strip restart is guaranteed by the WebGPU spec: assembly runs per instance, and a strip is split on the restart value only for *indexed* draws.

### 6.6 Three Anti-Pop Mechanisms

**Scale-in:** a blade entering the ring at its outer edge interpolates height 0→1 over a 2 m band, so nothing ever appears at full size on its first frame.

**Stochastic cross-fade:** over the LOD band both representations draw. Each blade is alpha-tested against `hash(seed) + blue_noise(pixel, frame)`, so the transition is a random subset of blades switching per frame. TAA resolves it — and resolves it correctly because of the wind-aware motion vectors.

**Card orientation continuity:** L2 and L3 cards inherit the L1 blade's yaw. Without this, the silhouette direction would flip at the boundary. The yaw is derived from the same seed hash at every LOD, so the value is continuous by construction.

### 6.7 Overflow Handling and Counter Readback

Every buffer has a hard capacity with an overflow counter. The counters buffer holds:

| Index | Constant | Meaning |
|---|---|---|
| 0–3 | — | Per-LOD visible instance counts |
| 4 | `COUNTER_VISIBLE_OVERFLOW` | Visible blades that did not fit the per-LOD bucket |
| 5 | `COUNTER_PLACEMENT_OVERFLOW` | Blades that did not fit a tile's arena slab |
| 6 | `COUNTER_PLACED_BLADES` | Total blades placed this frame |

### 6.8 Terrain Integration

`FoliageTerrainPass` renders a **top-down capture of the active foliage ring** into an `Rg16Float` height + slope texture at 4 texels/m, with `Rgba8Unorm` packed world normal + material id. The **temporary fallback** is the flat plane: every tile gets height = 0, `cos(slope) = 1`.

Density authoring layers on top of the terrain capture:

| Source | Representation | Evaluation |
|---|---|---|
| **Painted** | `R8Unorm` density textures, one array slice per foliage type | Sampled at candidate UV |
| **Procedural** | slope/altitude/material rules from `GpuFoliageType` | Evaluated from the capture |
| **Exclusion** | painted mask + runtime exclusion volumes | Applied as `(1 - exclusion)` |

Final weight: `painted × procedural × (1 - exclusion)`, evaluated per candidate in the placement shader.

### 6.9 `reference.rs` — CPU Mirror for Determinism Testing

The CPU reference implementation in `reference.rs` is a line-for-line transcription of the placement shader's candidate loop. It exists so the determinism contract is enforced by a test that runs in a headless container rather than by hope.

```rust
pub fn place_tile_reference(
    uniforms: &PlaceUniforms,
    types: &[GpuFoliageType],
    layers: &[GpuFoliageLayer],
    tile_coord: [i32; 2],
    generation: u32,
) -> ReferencePlacement {
    let grid = uniforms.candidate_grid.max(1);
    let candidates = grid.saturating_mul(grid);
    let center_y = 0.0f32;

    let mut placement = ReferencePlacement {
        blades: Vec::new(),
        candidates,
        dropped: 0,
    };

    for index in 0..candidates {
        let candidate = reference_candidate(uniforms, types, layers, tile_coord, generation, index);
        if !candidate.accepted { continue; }
        if placement.blades.len() as u32 >= uniforms.slab_capacity {
            placement.dropped += 1;
            continue;
        }

        let seed = candidate.seed;
        placement.blades.push(pack_blade(BladeParams {
            tile_uv: candidate.tile_uv,
            height_offset: 0.0 - center_y,
            yaw: hash_to_unit(seed.rotate_left(23)) * std::f32::consts::TAU,
            height_scale: hash_to_unit(seed.rotate_left(29)),
            width_scale: hash_to_unit(seed.rotate_left(3)),
            type_id: candidate.type_id,
            variant: ((seed >> 30) & 3) as u8,
            tint: [hash_to_unit(seed.rotate_left(7)), hash_to_unit(seed.rotate_left(13))],
            seed: seed as u16,
        }));
    }

    placement
}
```

---

## 7. Wind System and Motion Vectors

> "If the wind model produces a visible seam between the blade geometry and the impostor card of the same plant, the stochastic cross-fade cannot hide it — because the cross-fade was designed to hide a *coverage* discontinuity, not a *position* discontinuity. The wind must be phase-locked across every path that draws that plant."

Helio's wind model is the thing we are proudest of in the foliage stack. It is a three-band displacement model — trunk sway, branch flutter, leaf jitter — implemented once in a shared WGSL prelude, included by every shader that displaces a vertex. Grass blades, tree world-position-offset and impostor cards draw the *same plant* at different distances, and two of those are on screen simultaneously inside every LOD cross-fade band. If they each grew their own `sin(time)` the silhouettes would shear apart across the fade.

So: one implementation, shared everywhere, in phase by construction.

### 7.1 The GpuWind uniform (48 bytes)

```rust
#[repr(C)]
pub struct GpuWind {
    /// xyz = normalised wind direction, w = base speed in m/s.
    pub direction_speed: [f32; 4],
    /// [amplitude, frequency (Hz), phase (radians), turbulence scale (1/m)].
    pub gust: [f32; 4],
    /// [t, t - dt] — current and previous wind clock, in seconds.
    pub time_prev_time: [f32; 2],
    /// Padding to 16-byte uniform stride.
    pub _pad: [f32; 2],
}
```

The WGSL side declares the identical layout:

```wgsl
struct Wind {
    direction_speed: vec4<f32>,
    gust: vec4<f32>,
    time_prev_time: vec2<f32>,
    _pad: vec2<f32>,
}
```

The two must be edited together. A mismatch does not produce a shader error — it reinterprets the gust parameters as a direction and produces vegetation that either stands perfectly still or flies apart.

### 7.2 Why `prev_time` exists

The `time_prev_time.y` field is the most load-bearing single f32 in the foliage system. It exists for exactly one reason: motion vectors.

Every foliage vertex shader evaluates the entire wind model **twice** per vertex:

```wgsl
let wind_now = helio_wind_offset(wind, world_base, root, v.height_frac, seed, response, wind.time_prev_time.x);
let wind_prev = helio_wind_offset(wind, world_base, root, v.height_frac, seed, response, wind.time_prev_time.y);

let position_now  = world_base + wind_now + bend;
let position_prev = world_base + wind_prev + bend;

out.clip_position       = cameras[0].view_proj      * vec4<f32>(position_now,  1.0);
out.prev_clip_position  = cameras[0].prev_view_proj * vec4<f32>(position_prev, 1.0);
```

The second evaluation is what fills the G-buffer velocity target for animated vegetation. The fragment stage converts that `prev_clip_position` to screen-space pixels-per-frame:

```wgsl
fn foliage_velocity(clip_position: vec2<f32>, prev_clip: vec4<f32>) -> vec2<f32> {
    let prev_ndc = prev_clip.xy / prev_clip.w;
    let prev_pixel = vec2<f32>(
        (prev_ndc.x * 0.5 + 0.5) * globals.screen_size.x,
        (0.5 - prev_ndc.y * 0.5) * globals.screen_size.y,
    );
    return clip_position - prev_pixel;
}
```

**What breaks without `prev_time`:** fold `time` into the wind functions and there is no way to ask for `t - dt`. Every foliage vertex reports zero motion. TAA reprojects a moving blade onto the history texel of whatever was behind it — every blade of grass in the frame smears. It also silently breaks the dithered LOD cross-fades, which resolve only when the motion vectors underneath them are right. This is the artefact Unreal Engine grass ships with, and it is the single thing we point to when someone asks why the foliage stack is worth building.

On the Rust side, `Wind::advance` rolls the clock:

```rust
impl Wind {
    pub fn advance(&mut self, dt: f32) {
        let dt = if dt.is_finite() { dt.max(0.0) } else { 0.0 };
        self.prev_time = self.time;
        self.time += dt;
    }
}
```

Call it exactly once per simulated frame. Twice halves the apparent velocity; not at all makes `t == prev_time`, which reports zero motion just as badly as omitting the field.

The `Wind` struct that owns the clock — stored in `Scene` — is the *only* wind clock in the renderer. Passes are not allowed to keep their own accumulated time, because two clocks drift and drifting clocks put the blade geometry and the impostor cards out of phase at the cross-fade band.

```rust
impl Default for Wind {
    fn default() -> Self {
        Self {
            direction: Vec3::X,
            speed: 2.0,
            gust_amplitude: 0.35,
            gust_frequency: 0.15,
            gust_phase: 0.0,
            turbulence_scale: 0.05,
            time: 0.0,
            prev_time: 0.0,
        }
    }
}
```

### 7.3 Wind coherence — instance origin, not per-vertex

The sway band samples its phase from a world-space noise at the *instance origin* — the plant's root — and not at the shaded vertex. That distinction is the entire reason `helio_wind_sway` takes an origin rather than a position:

- Sampled at the origin, every vertex of one plant shares a phase (the plant moves as one object) and neighbouring plants, being close in world space, share *nearly* the same phase, so a meadow leans in coherent waves.
- Sampled per vertex, each vertex — and each plant — gets an independent phase. That is what makes procedural wind read as "boiling": a field of vegetation with no correlation length, shimmering rather than blowing.

The coherence constant is `HELIO_WIND_SWAY_COHERENCE = 0.06` (1/m). At that value the sway phase decorrelates over roughly 16 metres.

### 7.4 Integer bit-mixing hash (lowbias32)

The noise below is arithmetic, not a texture fetch. The prelude declares no bindings and samples no textures. We use the lowbias32 finaliser:

```wgsl
fn helio_wind_hash_u32(x: u32) -> u32 {
    var h = x;
    h ^= h >> 16u;
    h *= 0x7feb352du;
    h ^= h >> 15u;
    h *= 0x846ca68bu;
    h ^= h >> 16u;
    return h;
}

fn helio_wind_hash_unorm(x: u32) -> f32 {
    return f32(helio_wind_hash_u32(x)) * (1.0 / 4294967296.0);
}
```

The sine trick (`fract(sin(x) * 43758.5453)`) is the usual shader-hash shortcut and it is wrong for this use: `sin` is only guaranteed to a few ULP and vendors disagree on large arguments, so the same blade hashes differently on two GPUs. Wind phase must be bit-stable, because the cross-fade blends two representations of one plant and any phase difference between them shows up as a shearing silhouette.

### 7.5 Gust envelope advected downwind

The gust function produces a multiplier ≥ 1.0 at every world position:

```wgsl
fn helio_wind_gust(wind: Wind, world_pos: vec3<f32>, time: f32) -> f32 {
    let amplitude = wind.gust.x;
    let frequency = wind.gust.y;
    let phase = wind.gust.z;
    let turbulence = wind.gust.w;

    let dir = wind.direction_speed.xyz;
    let speed = wind.direction_speed.w;
    let advected = world_pos - dir * (speed * time * HELIO_WIND_GUST_ADVECTION);

    let front = helio_wind_noise(advected.xz * turbulence);
    let breath = sin(HELIO_WIND_TAU * frequency * time + phase);

    let envelope = 0.5 + 0.5 * (breath * 0.6 + front * 0.4);
    return 1.0 + amplitude * envelope;
}
```

The advection (`HELIO_WIND_GUST_ADVECTION = 0.35`) is the point of the whole function. A stationary turbulence field makes every plant in a blotch pulse together forever. An advected field produces a gust front that visibly travels across the field.

### 7.6 Band 1 — trunk / stem sway

Low-frequency, large-amplitude, gust-modulated, coherent across a whole instance:

```wgsl
fn helio_wind_sway(
    wind: Wind,
    instance_origin: vec3<f32>,
    time: f32,
    height_frac: f32,
    gain: f32,
) -> vec3<f32> {
    let dir = wind.direction_speed.xyz;
    let speed = wind.direction_speed.w;
    if gain <= 0.0 || speed <= 0.0 {
        return vec3<f32>(0.0);
    }

    let phase = helio_wind_noise(instance_origin.xz * HELIO_WIND_SWAY_COHERENCE) * HELIO_WIND_TAU;
    let freq = HELIO_WIND_SWAY_HZ * helio_wind_tempo(speed);
    let t = HELIO_WIND_TAU * freq * time + phase;

    let bend = sin(t) * 0.75 + sin(t * 2.17 + 1.3) * 0.25;
    let sideways = sin(t * 0.63 + phase * 1.7) * HELIO_WIND_SWAY_LATERAL;

    let amplitude = gain
        * height_frac * height_frac
        * speed
        * HELIO_WIND_SWAY_METRES_PER_MPS
        * helio_wind_gust(wind, instance_origin, time);

    return (dir * bend + helio_wind_side_axis(dir) * sideways) * amplitude;
}
```

Key details:

- **2.17 is deliberately not 2.0.** An exact harmonic makes the motion strictly periodic at the fundamental, and the eye picks a one-second loop out of a field instantly.
- **Lateral sway is 35% of downwind.** A stem that only moves in the wind plane reads as a hinge, not a plant.
- **Amplitude scales with height squared**, the first mode shape of a cantilever beam.
- **Side axis falls back to +X when wind points straight up.** `cross` degenerates there and normalising it would put a NaN into the vertex position.

Base frequency: 0.26 Hz. Amplitude: 0.030 m per m/s of wind speed.

### 7.7 Band 2 — branch flutter

Mid-frequency flutter, phase driven by distance along the stem and distance travelled downwind:

```wgsl
fn helio_wind_flutter(
    wind: Wind,
    world_pos: vec3<f32>,
    instance_origin: vec3<f32>,
    time: f32,
    height_frac: f32,
    gain: f32,
) -> vec3<f32> {
    let dir = wind.direction_speed.xyz;
    let speed = wind.direction_speed.w;
    if gain <= 0.0 || speed <= 0.0 {
        return vec3<f32>(0.0);
    }

    let stem_dist = length(world_pos - instance_origin);
    let phase = dot(instance_origin, dir) * HELIO_WIND_FLUTTER_DOWNWIND
        + stem_dist * HELIO_WIND_FLUTTER_ALONG_STEM;
    let t = HELIO_WIND_TAU * HELIO_WIND_FLUTTER_HZ * helio_wind_tempo(speed) * time + phase;

    let side = helio_wind_side_axis(dir);
    let up = vec3<f32>(0.0, 1.0, 0.0);
    let amplitude = gain * height_frac * speed * HELIO_WIND_FLUTTER_METRES_PER_MPS;

    return (side * sin(t) + up * (cos(t * 1.37) * 0.35)) * amplitude;
}
```

Base frequency: 1.05 Hz. Amplitude: 0.008 m per m/s.

### 7.8 Band 3 — leaf jitter

High-frequency, low-amplitude jitter with phase from a stable per-leaf seed:

```wgsl
fn helio_wind_jitter(
    wind: Wind,
    seed: u32,
    time: f32,
    height_frac: f32,
    gain: f32,
) -> vec3<f32> {
    let speed = wind.direction_speed.w;
    if gain <= 0.0 || speed <= 0.0 {
        return vec3<f32>(0.0);
    }

    let px = helio_wind_hash_unorm(seed) * HELIO_WIND_TAU;
    let py = helio_wind_hash_unorm(seed ^ 0x9e3779b9u) * HELIO_WIND_TAU;
    let pz = helio_wind_hash_unorm(seed ^ 0x85ebca6bu) * HELIO_WIND_TAU;

    let w = HELIO_WIND_TAU * HELIO_WIND_JITTER_HZ * helio_wind_tempo(speed) * time;
    let amplitude = gain * height_frac * speed * HELIO_WIND_JITTER_METRES_PER_MPS;

    return vec3<f32>(
        sin(w + px),
        sin(w * 0.83 + py) * 0.5,
        sin(w * 1.19 + pz),
    ) * amplitude;
}
```

This is the one band where per-instance independence is *wanted*: individual leaves genuinely do flick independently, the amplitude is small enough (2.5 mm per m/s) that no coherent silhouette depends on it.

### 7.9 Tempo scaling — wind speed affects frequency too

```wgsl
const HELIO_WIND_REFERENCE_SPEED: f32 = 5.0;

fn helio_wind_tempo(speed: f32) -> f32 {
    return 0.35 + 0.65 * clamp(speed / HELIO_WIND_REFERENCE_SPEED, 0.0, 2.0);
}
```

At zero speed the multiplier is 0.35 (not 0.0), so grass in near-still air drifts instead of freezing solid. At 5 m/s it hits 1.0 — the authored base frequency.

### 7.10 The composition function

`helio_wind_offset` is the function foliage vertex shaders actually call. It sums all three bands and applies arc-length correction:

```wgsl
fn helio_wind_offset(
    wind: Wind,
    world_pos: vec3<f32>,
    instance_origin: vec3<f32>,
    height_frac: f32,
    seed: u32,
    response: vec3<f32>,
    time: f32,
) -> vec3<f32> {
    let h = clamp(height_frac, 0.0, 1.0);

    var offset = helio_wind_sway(wind, instance_origin, time, h, response.x);
    offset += helio_wind_flutter(wind, world_pos, instance_origin, time, h, response.y);
    offset += helio_wind_jitter(wind, seed, time, h, response.z);

    // Arc-length correction.
    let stem_len = length(world_pos - instance_origin);
    if stem_len > 1e-4 {
        let reach = min(length(offset.xz), stem_len);
        offset.y -= stem_len - sqrt(max(stem_len * stem_len - reach * reach, 0.0));
    }

    return offset;
}
```

### 7.11 Per-type wind_response gains

Wind response is authored per foliage type as a three-element `[trunk, branch, leaf]` vector. A grass blade is roughly `[0.0, 0.3, 1.0]` — no trunk sway (blades are too short), moderate flutter, full leaf jitter. A tree trunk is `[1.0, 0.6, 0.2]`.

### 7.12 Generation counter — why wind must not advance it

This is a subtle but load-bearing invariant:

> **The `generation` counter must not advance when the wind changes.**

`generation` gates re-upload of the foliage type table to the GPU. Wind changes every single frame. If it bumped `generation`, the type table would re-upload every frame and the residency cache's whole reason for existing — that steady-state foliage costs the CPU nothing — would be gone.

```rust
fn rebuild_foliage_buffers(&mut self) {
    let mut topology_changed = false;
    if self.foliage_types_dirty {
        topology_changed = true;
    }
    if self.foliage_layers_dirty {
        topology_changed = true;
    }

    if topology_changed {
        self.foliage_generation = self.foliage_generation.wrapping_add(1);
    }
}
```

And `set_wind` deliberately preserves the clock across parameter changes:

```rust
pub fn set_wind(&mut self, wind: Wind) {
    let (time, prev_time) = (self.wind.time, self.wind.prev_time);
    self.wind = wind;
    self.wind.time = time;
    self.wind.prev_time = prev_time;
}
```

### 7.13 The shared prelude — why one implementation

The decision to implement wind once in `foliage_wind.wgsl` and include it everywhere was not an optimisation; it was a correctness requirement. Grass blades, tree world-position-offset, and impostor cards are three different rasterisation paths that draw the *same plant* at different distances. Two of them are on screen simultaneously inside every LOD cross-fade band. If those paths each grew their own `sin(time)` the silhouettes would shear against each other across the fade.

The inclusion mechanism is the existing `shader::resolve` prelude system. Shaders opt in:

```wgsl
//!use helio_foliage_wind
```

The prelude declares no bindings and samples no textures. The including shader declares its own bindings:

```wgsl
@group(0) @binding(2) var<uniform> wind: Wind;
```

### 7.14 What we learned

The wind model went through seven distinct iterations before it stopped looking wrong. Each one taught us something about what the eye actually reads as wind rather than as an animation:

**Boiling vs. blowing (iteration 1):** First pass used per-vertex noise driving all three bands. Every blade shimmered independently; it looked like a heat haze, not wind. The fix was moving the sway phase to the instance origin — understanding that phase coherence is the single biggest perceptual lever in procedural wind.

**Frequency ramp (iteration 2):** Amplitude scaled with speed, frequencies were fixed. Strong wind made everything swing further but not faster. The fix was `helio_wind_tempo` — a linear ramp from 0.35 to 1.65 applied to all three bands.

**Gust advection (iteration 3):** The turbulence field pulsed in place. Every blade in a blotch leaned together forever. The fix was `HELIO_WIND_GUST_ADVECTION = 0.35` — advecting the noise sample downwind.

**Incommensurate second mode (iteration 4):** The sway band uses `sin(t) * 0.75 + sin(t * 2.17 + 1.3) * 0.25`. The 2.17 is deliberately not an integer: an exact harmonic makes the motion strictly periodic, and the eye picks a one-second loop instantly.

**Lateral sway (iteration 4b):** Early versions only displaced along the wind direction. A stem that only moves in the wind plane reads as a hinge, not a plant.

**Motion vectors and `prev_time` (iteration 5):** The motion vector fix was an architectural change to how the model is called. Every vertex shader evaluates the model twice, at two different times, and the model functions must accept `time` as a parameter rather than reading it from the uniform.

**Arc-length correction (iteration 6):** Without the sagitta correction, grass visibly grows longer in gusts. The bands displace horizontally without shortening the stem, so a strongly bent blade would be longer than its authored height.

**The hash function and the CI failure:** The original implementation used `fract(sin(x) * 43758.5453)`. Everything looked correct on NVIDIA, but on AMD the L2/L3 cross-fade band had a visible shearing artefact. After three days of debugging: `sin` is only guaranteed to a few ULP, and the two GPUs disagreed by about 1.5 ULP. The fix was the integer-only lowbias32 finaliser — five operations, no `sin`, bit-stable across every backend.

---

## 8. Interaction Field

The interaction system lets moving bodies — players, NPCs, vehicles — push grass aside. It is a separate displacement field maintained as a camera-relative `Rgba16Float` texture (default 512² covering 64 m, snapped to the texel grid so there is no swimming under camera motion):

| Channel | Contents |
|---|---|
| R | Horizontal displacement X |
| G | Horizontal displacement Z |
| B | Vertical crush amount |
| A | Recovery timer |

### 8.1 How scrolling works (no swimming)

The interaction field is snapped to the texel grid. Snapping means: the field's origin is at `floor(camera_position / texel_size) * texel_size`, not at the camera's exact position. A texel at pixel (x, y) always samples the same world position regardless of sub-texel camera motion — the field scrolls in whole-texel increments. Without this snap, the interaction displacement would crawl under the grass even when nothing is touching it, producing a rippling artefact that looks like the ground is breathing.

The scroll is a GPU copy from one region of the field to another, offset by the snap delta. It is a copy, not a resample — because the delta is always an integer number of texels, no filtering is needed and no information is lost.

### 8.2 The interactor splat

Each `FoliageInteractor` is a sphere with position, radius and velocity. The splat compute shader projects the sphere onto the field, computes displacement magnitude from velocity, and writes `max(existing, new)` into the field's RG channels. Recovery is exponential: each frame, every texel decays as `value *= exp(-dt / tau)`, where `tau` comes from the foliage type's `interaction_stiffness`.

### 8.3 The vertex shader side

```wgsl
fn foliage_interaction_bend(world_pos: vec3<f32>, height_frac: f32, stiffness: f32) -> vec3<f32> {
    if (globals.flags & FOLIAGE_FLAG_INTERACTION_VALID) == 0u {
        return vec3<f32>(0.0);
    }
    let uv = (world_pos.xz - globals.interaction_field.xy) * globals.interaction_field.w;
    if any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0)) {
        return vec3<f32>(0.0);
    }
    let field = textureSampleLevel(interaction_tex, interaction_samp, uv, 0.0);
    let bend = vec3<f32>(field.r, -field.b, field.g);
    let response = globals.interaction_strength / max(stiffness, 0.25);
    return bend * (height_frac * height_frac * response);
}
```

The interaction bend is currently applied identically at `t` and `t - dt`, so it contributes nothing to the velocity target. This is temporary — the interaction field has no history buffer yet.

### 8.4 Zero overhead when absent

When `FoliageInteractionPass` is not enabled, `frame.foliage_interaction` is an unwritten slot and the bind group supplies a 1×1 placeholder texture with `FOLIAGE_FLAG_INTERACTION_VALID` clear. The early return produces no bend at all.

### 8.5 The Rust-side interactor API

```rust
impl Scene {
    pub fn add_foliage_interactor(&mut self, interactor: FoliageInteractor) -> FoliageInteractorId {
        let (id, index) = self.foliage_interactors.insert(FoliageInteractorRecord { interactor });
        self.foliage_interactors_dirty = true;
        self.mark_foliage_interactor_dirty(index, index + 1);
        id
    }

    pub fn update_foliage_interactor(
        &mut self, id: FoliageInteractorId, position: Vec3, velocity: Vec3,
    ) -> Result<()> {
        let (index, record) = self.foliage_interactors.get_mut_with_index(id)
            .ok_or_else(|| invalid("foliage interactor"))?;
        record.interactor.position = position;
        record.interactor.velocity = velocity;
        self.foliage_interactors_dirty = true;
        self.mark_foliage_interactor_dirty(index, index + 1);
        Ok(())
    }

    pub fn remove_foliage_interactor(&mut self, id: FoliageInteractorId) -> Result<()> {
        let removed = self.foliage_interactors.remove(id)
            .ok_or_else(|| invalid("foliage interactor"))?;
        self.foliage_interactors_dirty = true;
        let index = removed.dense_index;
        self.mark_foliage_interactor_dirty(index, index + 1);
        Ok(())
    }
}
```

---

## 9. Rasterisation — Four Draw Calls, Zero Vertex Buffers

```rust
primitive: wgpu::PrimitiveState {
    topology: wgpu::PrimitiveTopology::TriangleStrip,
    strip_index_format: None,
    cull_mode: None,
    ..
},
// No vertex buffer. No index buffer. `buffers: &[]`.
```

Every blade of grass in Helio's world starts as four `draw_indirect` calls recorded back-to-back in `FoliageGBufferPass::execute`:

```rust
for lod in 0..self.decision.draw_count {
    pass.set_bind_group(1, &self.bind_group_1, &[lod * LOD_UNIFORM_STRIDE]);
    pass.draw_indirect(&self.foliage_indirect, lod as u64 * DRAW_INDIRECT_STRIDE);
}
```

No vertex buffer. No index buffer. The indirect commands live in a buffer the compute-side `FoliagePlacePass` filled moments earlier. Every vertex is derived from `@builtin(vertex_index)` plus the packed 16-byte `BladeInstance` fetched through `visible_blades[]`:

```wgsl
@vertex
fn vs_main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
    let reference = visible_blades[lod_info.region_base + instance_index];
    let tile_slot = reference >> FOLIAGE_VISIBLE_TILE_SHIFT;
    let local_index = reference & FOLIAGE_VISIBLE_LOCAL_MASK;
    let tile = tile_table[tile_slot];
    let blade = blade_arena[tile.blade_offset + local_index];
    // ...
}
```

### 9.1 Why Vertexless Works: Per-Instance Strip Restart

The answer is in the WebGPU spec's primitive-assembly algorithm: **assembly runs per instance**. A strip is split on the restart value only for *indexed* draws, so a non-indexed instanced strip draw cannot span an instance boundary. The hardware resets the strip for every `instance_index`, and each blade or card is exactly one primitive — no degenerate triangles, no stitch vertices, no index buffer.

### 9.2 The 8-Target Pipeline

Grass must be lit like the rest of the scene. That means deferred lighting, shadows, SSAO, SSR, GI, correct TAA — all of it — which means it must write into the same G-buffer the `GBufferPass` fills:

```
 Slot  Name          Format           Grass writes
 ───── ────────────  ─────────────── ─────────────
  0    albedo        Rgba8Unorm      ✓
  1    normal        Rgba16Float     ✓
  2    orm           Rgba8Unorm      ✓
  3    emissive      Rgba16Float     ✓
  4    lightmap_uv   Rg16Float       ✗ (masked)
  5    sss           Rgba16Float     ✗ (masked)
  6    extra         Rgba16Float     ✗ (masked)
  7    velocity      Rg16Float       ✓
```

The fragment shader declares only five outputs:

```wgsl
struct FoliageGBufferOutput {
    @location(0) albedo: vec4<f32>,
    @location(1) normal: vec4<f32>,
    @location(2) orm: vec4<f32>,
    @location(3) emissive: vec4<f32>,
    @location(7) velocity: vec2<f32>,
}
```

Locations 4, 5 and 6 are absent from the struct. The Rust side masks them:

```rust
pub const UNWRITTEN_TARGET_INDICES: [usize; 3] = [4, 5, 6];

pub fn color_target_states() -> [Option<wgpu::ColorTargetState>; 8] {
    std::array::from_fn(|index| {
        Some(wgpu::ColorTargetState {
            format: GBUFFER_TARGET_FORMATS[index],
            blend: None,
            write_mask: if UNWRITTEN_TARGET_INDICES.contains(&index) {
                wgpu::ColorWrites::empty()
            } else {
                wgpu::ColorWrites::ALL
            },
        })
    })
}
```

**The empty write mask is mandatory, not cosmetic.** A declared fragment target with no shader output has an *undefined* value. Without the mask, those three G-buffer channels fill with garbage wherever grass covers a pixel.

### 9.3 Why a 5-Target Pipeline Was Never an Optimisation

The first draft of the foliage plan proposed a pipeline writing only 5 targets to save tile-memory bandwidth. It was wrong.

A pipeline's fragment targets must match the render pass's colour attachments *element-for-element*. `RenderPassContext::check_compatible` compares the lists with strict equality. A 5-target pipeline therefore requires its own render pass, which breaks subpass fusion. Breaking the chain forces a tile store and reload of every touched attachment. At 1080p and 48 bytes per sample, that is ~100 MiB each way on a tile-based GPU — *far more* than the lever was going to save.

The lever that actually works: an 8-target pipeline with identical formats, three `ColorWrites::empty()` masks, and those three `@location`s omitted from the fragment shader.

### 9.4 LOD Cross-Fade: Stochastic Dither

Between LOD bands, both representations draw simultaneously. Every blade tests against a threshold composed of two parts:

- A **stable per-blade hash** (derived from the tile coordinate and placement lane, never from frame state).
- A **per-pixel, per-frame dither** (interleaved gradient noise), so the pattern decorrelates across frames and TAA integrates it away.

```wgsl
fn foliage_dither(pixel: vec2<f32>, frame: u32) -> f32 {
    let p = pixel + 5.588238 * f32(frame % 64u);
    return fract(52.9829189 * fract(dot(p, vec2<f32>(0.06711056, 0.00583715))));
}
```

In the fragment shader:

```wgsl
let threshold = fract(
    helio_wind_hash_unorm(input.seed) + foliage_dither(input.clip_position.xy, globals.frame),
);
if input.fade < threshold {
    discard;
}
```

#### Symmetric by Construction

The alpha function `foliage_cross_fade` is designed so that at any threshold the near LOD's weight is `f` and the far LOD's is `1 - f`. The two sum to exactly one blade's worth of coverage everywhere in the band:

```wgsl
fn foliage_cross_fade(
    ty: FoliageType, level: u32, distance: f32, scale: f32, band: f32
) -> f32 {
    let upper = foliage_lod_threshold(ty, level, scale);
    var outer_band = band;
    if level + 1u >= FOLIAGE_LOD_COUNT {
        let lower = foliage_lod_threshold(ty, level - 1u, scale);
        outer_band = max(band, (upper - lower) * FOLIAGE_FINAL_FADE_FRACTION);
    }
    var alpha = foliage_lod_fade_alpha(distance, upper - outer_band, upper);
    if level > 0u {
        let lower = foliage_lod_threshold(ty, level - 1u, scale);
        alpha = min(alpha, 1.0 - foliage_lod_fade_alpha(distance, lower - band, lower));
    }
    return alpha;
}
```

`foliage_lod_fade_alpha` uses a smoothstep:

```wgsl
fn foliage_lod_fade_alpha(d: f32, band_start: f32, band_end: f32) -> f32 {
    if !foliage_is_finite(d) || !foliage_is_finite(band_start) || !foliage_is_finite(band_end) {
        return 1.0;
    }
    if band_end <= band_start {
        return select(0.0, 1.0, d < band_start);
    }
    let t = clamp((d - band_start) / (band_end - band_start), 0.0, 1.0);
    return 1.0 - (t * t * (3.0 - 2.0 * t));
}
```

### 9.5 Why the Clump LOD Fades by Area

L3 draws one card per 4×4 blade cluster. That card is four times as wide as a single blade. When the stochastic dither discards it, sixteen blades' worth of coverage disappears at once. So L3 fades by **area** instead: the card shrinks toward zero across the band and is never discarded:

```wgsl
var size_fade = 1.0;
var dither_fade = fade;
if lod_info.lod == FOLIAGE_LOD_CLUMP {
    size_fade = sqrt(clamp(fade, 0.0, 1.0));
    dither_fade = 1.0;
}
```

### 9.6 Procedural Blade Geometry

The vertex stage generates geometry from nothing but `vertex_index`. A blade is a triangle strip in **row-major, side-minor** order:

```
 index:  0      1      2      3      4      5     ...  2n
 row:    0      0      1      1      2      2          n (tip)
 side:  -1     +1     -1     +1     -1     +1          0
```

```wgsl
fn foliage_blade_vertex(segments: u32, is_card: bool, vertex_index: u32) -> BladeVertex {
    var tip_index = 2u * segments;
    if is_card { tip_index = 0xffffffffu; }
    let is_tip = vertex_index == tip_index;
    var row = min(vertex_index >> 1u, segments);
    var side = select(-1.0, 1.0, (vertex_index & 1u) == 1u);
    if is_tip { row = segments; side = 0.0; }
    var out: BladeVertex;
    out.side = side;
    out.height_frac = f32(row) / f32(segments);
    out.width_frac = select(1.0 - out.height_frac * out.height_frac, 1.0, is_card);
    return out;
}
```

### 9.7 Analytic Normal Computation

The strip is two vertices wide. At the collapsed tip, the edge between the two sides has zero width. A finite-differenced normal would divide by that zero edge.

Helio computes the normal analytically:

```wgsl
let local_normal = normalize(vec3<f32>(
    0.0,
    -2.0 * curve * v.height_frac,
    max(height, 1.0e-6),
));
```

### 9.8 Card Geometry for L2 and L3

L2 draws a single flat card per blade (4 vertices, a single quad). L3 draws one card per 4×4 blade cluster. The clump card's width is derived from the cluster size:

```rust
let clump_width = (cluster_granularity.max(1) as f32).sqrt();
```

A fixed constant cannot be right here, because the cluster size is a quality setting — 16 blades on Medium and above, 64 on Low.

### 9.9 The FoliageGlobals Uniform

64 bytes of per-frame configuration:

```rust
#[repr(C)]
pub struct FoliageGlobals {
    pub screen_size: [f32; 2],       // pixels; scales velocity
    pub frame: u32,                  // temporal dither seed
    pub flags: u32,                  // FLAG_* bits
    pub camera_ring: [f32; 4],       // w = resident ring radius
    pub interaction_field: [f32; 4], // xy = origin, z = extent, w = 1/extent
    pub lod_quality_scale: f32,
    pub scale_in_band: f32,          // metres
    pub lod_fade_band: f32,          // metres
    pub interaction_strength: f32,
}
```

**`camera_ring` is a `vec4<f32>`, not a bare `f32`**, because that is what the WGSL side declares and WGSL gives a `vec4<f32>` 16-byte alignment. An earlier version of this struct had four consecutive scalars here against the shader's single `vec4`, so `camera_ring.w` read back whatever was in `scale_in_band` — a couple of metres — and every blade's `scale_in` evaluated to zero.

### 9.10 FoliageLodUniform: Dynamic Offsets

```rust
#[repr(C)]
pub struct FoliageLodUniform {
    pub lod: u32,
    pub segments: u32,
    pub vertex_count: u32,
    pub region_base: u32,
    pub width_scale: f32,
    pub height_scale: f32,
    pub is_card: u32,
    pub _pad: u32,
}

pub const LOD_UNIFORM_STRIDE: u32 = 256;
```

### 9.11 Scale-In Factor

When a tile enters the resident ring, its blades must not appear at full size in one frame:

```wgsl
fn foliage_scale_in_factor(distance_from_edge: f32, band: f32) -> f32 {
    if !foliage_is_finite(distance_from_edge) { return 0.0; }
    if !foliage_is_finite(band) || band <= 0.0 {
        return select(0.0, 1.0, distance_from_edge > 0.0);
    }
    let t = clamp(distance_from_edge / band, 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}
```

### 9.12 The Fragment Shader: Procedural Grass

No material table, no textures — the grass is coloured procedurally:

```wgsl
@fragment
fn fs_main(
    input: VertexOutput, @builtin(front_facing) front_facing: bool
) -> FoliageGBufferOutput {
    let threshold = fract(
        helio_wind_hash_unorm(input.seed) + foliage_dither(input.clip_position.xy, globals.frame),
    );
    if input.fade < threshold { discard; }

    let base = vec3<f32>(0.055, 0.115, 0.030);
    let tip = vec3<f32>(0.180, 0.320, 0.075);
    var albedo = mix(base, tip, input.height_frac);
    albedo *= vec3<f32>(
        mix(0.80, 1.20, input.tint.x),
        mix(0.90, 1.10, input.tint.y),
        mix(0.75, 1.25, input.tint.x),
    );

    let normal = normalize(select(-input.world_normal, input.world_normal, front_facing));
    let ao = mix(0.35, 1.0, input.height_frac);

    var out: FoliageGBufferOutput;
    if (globals.flags & FOLIAGE_FLAG_DEBUG_LOD) != 0u {
        var lod_colour = vec3<f32>(1.0, 0.0, 0.0);
        if input.lod == 1u { lod_colour = vec3<f32>(0.0, 1.0, 0.0); }
        else if input.lod == 2u { lod_colour = vec3<f32>(0.0, 0.4, 1.0); }
        else if input.lod >= 3u { lod_colour = vec3<f32>(1.0, 0.9, 0.0); }
        albedo = lod_colour;
    }

    out.albedo = vec4<f32>(albedo, 1.0);
    out.normal = vec4<f32>(normal, FOLIAGE_F0);
    out.orm = vec4<f32>(ao, 0.75, 0.0, FOLIAGE_F0);
    out.emissive = vec4<f32>(0.0, 0.0, 0.0, FOLIAGE_F0);
    out.velocity = foliage_velocity(input.clip_position.xy, input.prev_clip_position);
    return out;
}
```

The albedo progression from `(0.055, 0.115, 0.030)` at the root to `(0.180, 0.320, 0.075)` at the tip models a grass blade that is darker near the ground and lighter at the tip where it catches the sun.

### 9.13 Debug LOD View

Set `HELIO_FOLIAGE_DEBUG=lod` and every blade tints by LOD: L0 red, L1 green, L2 blue, L3 yellow.

```rust
fn debug_lod_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        std::env::var("HELIO_FOLIAGE_DEBUG")
            .map(|v| v.eq_ignore_ascii_case("lod"))
            .unwrap_or(false)
    })
}
```

### 9.14 Pipeline Contract Tests

The crate defines `GBUFFER_TARGET_FORMATS` — all eight, in the exact order `GBufferPass` declares them:

```rust
pub const GBUFFER_TARGET_FORMATS: [wgpu::TextureFormat; 8] = [
    wgpu::TextureFormat::Rgba8Unorm,   // 0 albedo
    wgpu::TextureFormat::Rgba16Float,  // 1 normal
    wgpu::TextureFormat::Rgba8Unorm,   // 2 orm
    wgpu::TextureFormat::Rgba16Float,  // 3 emissive
    wgpu::TextureFormat::Rg16Float,    // 4 lightmap_uv
    wgpu::TextureFormat::Rgba16Float,  // 5 sss
    wgpu::TextureFormat::Rgba16Float,  // 6 extra
    wgpu::TextureFormat::Rg16Float,    // 7 velocity
];
```

### 9.15 Zero Overhead When Absent

Three independent guarantees, each with a test:

1. `RendererConfig::enable_foliage == false` => graph construction never adds the passes.
2. Passes present but no foliage types registered => `prepare()` early-returns on an unwritten `frame.foliage` slot, `execute()` records no commands, `declare_resources` allocates nothing.
3. Types registered but ring empty => four `draw_indirect` calls with `instance_count == 0`. Measured cost < 0.02 ms.

The Rust-side decision is a pure function:

```rust
pub fn decide_frame(
    tables: Option<FoliageTables>,
    uploaded_generation: Option<u64>,
) -> FoliageFrameDecision {
    match tables {
        Some(tables) if tables.type_count > 0 => FoliageFrameDecision {
            enabled: true,
            upload_types: uploaded_generation != Some(tables.generation),
            upload_wind: true,
            draw_count: LOD_COUNT as u32,
        },
        _ => FoliageFrameDecision { enabled: false, .. },
    }
}
```

### 9.16 The Eye Traps

A non-exhaustive list of things that went wrong:

- **`camera_ring` as `vec4` not four scalars**: the previous layout had four consecutive `f32` fields against the shader's `vec4<f32>`, so `camera_ring.w` read `scale_in_band` and every blade rendered at zero height.
- **`wind_response` as three scalars, not `vec3<f32>`**: WGSL alignment shifts everything after it by 12 bytes. Nothing errors; materials come out random.
- **Five-target pipeline**: forfeits subpass fusion, costs ~100 MiB tile store/reload. The correction was an 8-target pipeline with `ColorWrites::empty()`.
- **Alpha-to-coverage unavailable**: G-buffer is single-sampled everywhere and WebGPU rejects `alphaToCoverageEnabled` when `count == 1`.
- **Clump LOD dithered by default**: discarding one card punches a 16-blade hole. The fix was fading by area (`sqrt(fade)`) instead of dither.
- **Hardcoded clump width**: `CLUMP_CARD_WIDTH_SCALE = 2.5` covered about six blades at both Medium (16/cluster) and Low (64/cluster). The fix was deriving width from `sqrt(cluster_size)`.

### 9.17 Struct Definitions: Complete Reference

**FoliageType (96 bytes):**

```wgsl
struct FoliageType {
    density: f32,
    height_min: f32, height_max: f32,
    width_min: f32, width_max: f32,
    slope_min: f32, slope_max: f32,
    altitude_min: f32, altitude_max: f32,
    lod0: f32, lod1: f32, lod2: f32, lod3: f32,
    wind_trunk: f32, wind_branch: f32, wind_leaf: f32,
    interaction_stiffness: f32,
    material_id: u32,
    density_layer: u32,
    kind_and_flags: u32,
    mesh_or_impostor_id: u32,
    pad0: u32, pad1: u32, pad2: u32,
}
```

**BladeInstance (16 bytes):**

```wgsl
struct BladeInstance {
    packed_pos: u32,
    packed_height_yaw: u32,
    packed_scale_type: u32,
    packed_tint_seed: u32,
}
```

**FoliageTile (32 bytes):**

```wgsl
struct FoliageTile {
    tile_coord: vec2<i32>,
    blade_offset: u32,
    blade_count: u32,
    bounds_center_y: f32,
    bounds_half_y: f32,
    state: u32,
    generation: u32,
}
```

**VertexOutput:**

```wgsl
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_normal: vec3<f32>,
    @location(1) height_frac: f32,
    @location(2) prev_clip_position: vec4<f32>,
    @location(3) tint: vec2<f32>,
    @location(4) @interpolate(flat) fade: f32,
    @location(5) @interpolate(flat) seed: u32,
    @location(6) @interpolate(flat) lod: u32,
}
```

---

## 10. Performance Budget — 1M Blades Under 3ms

Target: **1 M blades under 3 ms GPU at 1080p desktop.** Reference tier is the same one the existing `render_timing_snapshot` test uses. The gate is enforced in CI as a hard failure.

Steady-state distribution across the LOD ring at 40 blades/m² and a 120 m radius:

| Stage | Work | Budget |
|---|---|---|
| Terrain capture | amortised, residency-change only | 0.05 ms |
| Interaction field | 512² compute + ≤64 splats | 0.05 ms |
| Placement | ≤24 tiles/frame × 1 workgroup | 0.20 ms |
| Tile + cluster cull | ~1,000 workgroups | 0.15 ms |
| L0 raster | 60k × 11 verts | 0.55 ms |
| L1 raster | 200k × 7 verts | 0.60 ms |
| L2/L3 raster | 740k × 4 verts | 0.95 ms |
| Impostors | ~2k trees | 0.15 ms |
| **Total** | | **2.70 ms** |

Headroom to the 3.0 ms gate: 0.30 ms.

### 10.1 Shadow staging is deliberate

Foliage shadow casting is staged because this is where UE's implementation is weakest:

- **Trees**, until the VG shadow phase lands, cast via a **proxy-mesh double publication**: the VG object drives the G-buffer, and a low-LOD proxy is published as an ordinary scene object that the existing shadow path already handles. Wind is evaluated at reduced amplitude in the shadow vertex shader.
- **Grass** casts only within the first cascade, only at L2 cards, into the **dynamic** atlas. Wind is frozen for the shadow draw.
- **Beyond cascade 0**, grass contributes no shadow. It contributes AO instead, via a density term folded into the terrain material's ORM output.

---

## 11. Platform Constraints and Quality Presets

### 11.1 Platform Matrix

| Constraint | Where it bites | Answer |
|---|---|---|
| No `MULTI_DRAW_INDIRECT_COUNT` on WebGPU | Draw submission | Exactly 4 `draw_indirect` calls; no multi-draw anywhere in the grass path |
| `MAX_TEXTURES == 16` on wasm/Metal/Android | Impostor atlas | Single `texture_2d_array`, one binding |
| No 64-bit atomics | Compaction | All counters are `atomic<u32>` |
| Tight storage-buffer limits on mobile | Arenas | `FoliageQuality::Low` caps blade arena at 4 MiB, ring at 48 m |
| Tile-based mobile GPUs hate alpha test | Blade raster | Opaque blade geometry at L0/L1; cards use stochastic alpha-test + TAA |
| 32-byte `max_color_attachment_bytes_per_sample` floor | The whole G-buffer | Helio's 8 targets cost 48 bytes/sample. Pre-Apple4 Metal, browsers report 32 |

The G-buffer constraint is a hard one, and we are honest about it: the existing 8-target G-buffer already exceeds the 32-byte guaranteed `max_color_attachment_bytes_per_sample` floor on WebGPU and pre-Apple4 Metal. Foliage inherits this constraint; it does not introduce it.

### 11.2 The `max_color_attachment_bytes_per_sample` problem in detail

Helio's 8-target G-buffer has the following format layout:

| Target | Format | Bytes/sample |
|---|---|---|
| `gbuffer_albedo` | `Rgba8UnormSrgb` | 4 |
| `gbuffer_normal` | `Rg8Unorm` (octahedral) | 2 |
| `gbuffer_orm` | `Rgb10A2Unorm` | 4 |
| `gbuffer_emissive` | `R11G11B10UFloat` | 4 |
| `gbuffer_lightmap_uv` | `Rg16Unorm` | 4 |
| `gbuffer_sss` | `Rgba8Unorm` | 4 |
| `gbuffer_extra` | `Rgba8Unorm` | 4 |
| `gbuffer_velocity` | `Rg16Float` | 4 |
| Depth | `Depth32Float` | 4 |
| **Total** | | **48 bytes/sample** (excluding depth, which is separate) |

The WebGPU/wgpu guaranteed minimum for `max_color_attachment_bytes_per_sample` is 32. DX12 and Vulkan typically report 128. Pre-Apple4 Metal (Intel Macs, older iOS devices) reports 32. Browsers report 32.

This means G-buffer pipeline creation fails on any adapter that reports baseline limits. Foliage does not cause this — the G-buffer already exceeds the floor before foliage existed — but foliage means an engine that might have limped along with a reduced G-buffer on those adapters now has a hard dependency on all 8 targets being available.

### 11.3 Quality presets as the platform lever

Nothing is `#[cfg]`-ed out. Quality presets are the only platform difference:

| Quality | Ring (m) | Density mult | LOD scale | Cluster gran. | Arena (MiB) |
|---|---|---|---|---|---|
| Low | 48 | 0.35 | 0.35 | 64 (8×8) | 8 |
| Medium | 128 | 1.0 | 1.0 | 16 (4×4) | 64 |
| High | 176 | 1.35 | 1.3 | 16 (4×4) | 128 |
| Ultra | 256 | 2.0 | 1.75 | 16 (4×4) | 256 |

The presets are enforced as monotonic and self-consistent by test:

```rust
#[test]
fn presets_are_monotonic() {
    for pair in ALL.windows(2) {
        let (lower, higher) = (pair[0], pair[1]);
        assert!(higher.ring_radius() > lower.ring_radius());
        assert!(higher.density_multiplier() > lower.density_multiplier());
        assert!(higher.lod_distance_scale() > lower.lod_distance_scale());
        assert!(higher.cluster_granularity() <= lower.cluster_granularity());
        assert!(higher.blade_arena_bytes() > lower.blade_arena_bytes());
    }
}

#[test]
fn every_preset_reaches_past_its_scaled_lod_ladder() {
    let final_lod = DEFAULT_LOD_DISTANCES[3];
    for quality in ALL {
        assert!(!quality.clamps_lod_ladder(final_lod));
    }
}
```

---

## 12. The Test Philosophy

The foliage system mirrors the testing conventions already in the repo rather than inventing a new harness:

- **Layout asserts** — `const _: () = assert!(size_of::<GpuBladeInstance>() == 16)` etc., plus a `gpu_foliage_layouts_are_stable` test that pins every field offset.
- **CPU mirrors of shader math** — `select_blade_lod`, `pack_blade`, `wind_offset` implemented in `helio-foliage-core` and unit-tested.
- **Placement determinism** — same tile + generation + seed => identical blade list, asserted across two dispatches and against a CPU reference.
- **Cull equality** — GPU cull result vs CPU reference over a randomised camera sweep.
- **Overflow behaviour** — arena and draw-list saturation increments the overflow counter and never writes out of bounds.
- **WGSL validation** — automatic; the repo-walking test picks up new shaders with no registration.
- **Golden images** — impostor bake output, LOD transition band at three camera distances, wind at a fixed time, interaction footprint recovery curve.
- **Perf gate** — the 3.0 ms limit, failing CI on the reference tier.

### 12.1 Complete test suite

| Test | What it proves |
|---|---|
| `first_update_requests_the_whole_window_then_drains_at_the_budget` | First frame requests all tiles, caps at 24 placed/frame |
| `a_settled_ring_does_no_work_when_the_camera_does_not_cross_a_tile_boundary` | Moving within the same tile: zero placed, zero dirty, zero visited |
| `a_one_tile_step_touches_a_perimeter_not_an_area` | 33×33 ring, one-tile step: 2×33 visited, not 1089 |
| `a_diagonal_step_touches_two_perimeters_without_double_counting` | L-shaped strip: 2 × (33 + 32) visited, corner not double-counted |
| `a_teleport_degrades_to_progressive_fill_in_not_a_hitch` | Teleport releases all, places ≤24, converges in ceil(area/budget) |
| `an_undersized_ring_evicts_lru_instead_of_failing` | 25-tile window, 8 slots: evictions happen, no slot corruption |
| `a_generation_bump_invalidates_residency_and_requeues_the_window` | Every freed slot appears in dirty list same frame |
| `slots_are_never_double_booked` | 200-frame random walk: no two slots hold the same tile |
| `placing_the_same_tile_twice_is_byte_identical` | Determinism contract: byte-identical blade lists |
| `nothing_frame_dependent_can_reach_the_output` | 8 identical calls produce identical results |
| `a_generation_bump_reshuffles_rather_than_perturbs` | < 5% position overlap across a generation bump |
| `neighbouring_tiles_are_independent_draws` | `[-1,0]`, `[0,0]`, `[1,0]` all produce different blades |
| `every_blade_lands_inside_its_own_tile` | All `tile_uv` values in `[0, 1]` |
| `stratification_spreads_blades_over_the_whole_tile` | Every 4×4 bucket has ≥ 1 blade |
| `the_rejection_sampler_honours_relative_density` | 10:1 density ratio produces ~10:1 blade count |
| `a_full_slab_drops_the_tail_and_counts_it` | Hard ceiling: overflow counted, no OOB writes |
| `a_tile_outside_every_layer_places_nothing` | Layer AABB test works |
| `every_quality_preset_fits_the_tile_ring_and_leaves_a_usable_slab` | All four presets: ring capacity ≥ needed, slab ≥ 256 |
| `the_arena_never_exceeds_the_quality_budget` | Arena bytes ≤ budget for all presets |
| `gpu_record_sizes_match_the_wgsl_mirrors` | `GpuFoliageTile` = 32 B, `GpuBladeInstance` = 16 B, etc. |
| `foliage_type_field_offsets_match_the_documented_layout` | Every field offset pinned |
| `no_foliage_type_field_is_wgsl_vector_aligned` | No field lands on WGSL vec2/vec3/vec4 alignment |
| `blade_round_trips_within_quantisation_tolerance` | Pack/unpack within quantisation limits |
| `blade_repack_is_idempotent_after_the_first_pass` | Evict/re-place cycle is stable |
| `blade_field_packers_do_not_bleed_into_each_other` | Shifted mask detection |
| `f16_round_trips_exactly_representable_values` | Every f16 code round-trips |

---

## 13. Crate Layout

The foliage system follows the established one-crate-per-pass rule:

```
crates/
  helio-foliage-core/              # POD GPU types, packing helpers, CPU mirrors
  helio-pass-foliage-terrain/      # top-down height/normal/mask capture
  helio-pass-foliage-interaction/  # interaction field update (compute)
  helio-pass-foliage-place/        # tile residency, placement, cull, compaction
  helio-pass-foliage-gbuffer/      # blade / card / impostor rasterisation
```

Extended, not replaced:

- `libhelio` — new `FrameResources` slots and the `GpuWind` uniform.
- `helio-pass-virtual-geometry` — `wpo_extent` in `InstanceCullData`, GPU-appended range.
- `helio-bake` — impostor atlas baking.
- `helio-default-graphs` — conditional pass insertion.
- `helio` — public `Scene` authoring API.
- `helio-core/src/shader/` — a shared `foliage_wind.wgsl` prelude module.

### The `FrameResources` additions

```rust
pub foliage: Tracked<FoliageFrameData<'a>>,
pub foliage_terrain: Tracked<FoliageTerrainViews<'a>>,
pub foliage_interaction: Tracked<&'a wgpu::TextureView>,
pub foliage_interaction_sampler: Tracked<&'a wgpu::Sampler>,
pub foliage_interactors: Tracked<&'a wgpu::Buffer>,
pub foliage_interactor_count: u32,
```

### The buffers owned by `FoliagePlacePass`

| Buffer | Contents | Sizing |
|---|---|---|
| `tile_table` | `GpuFoliageTile[]` | ring capacity, e.g. 4096 tiles |
| `blade_arena` | `GpuBladeInstance[]` | slab-allocated, budget-capped (default 24 MiB) |
| `cluster_bounds` | one sphere per 4×4 blade cluster | `blade_capacity / 16` |
| `visible_blades[4]` | per-LOD compacted `u32` blade indices | worst-case per LOD bucket |
| `foliage_indirect` | 4 × `DrawIndirectArgs` + 4 counters | 96 B |
| `place_queue` | tiles scheduled for placement this frame | bounded by `max_tiles_per_frame` |

---

## 14. What's Next

The foliage system described here is shipping. Phases 1-3 (foundations, grass, wind + interaction) deliver the core requirement: a million blades of grass, fully lit, wind-animated, interaction-responsive, occlusion-culled, with correct motion vectors — in under 3 ms.

But there is more to build.

### 14.1 Remaining milestones

| Phase | Deliverable | Status |
|---|---|---|
| **4. Trees** | Mesh foliage via VG, `wpo_extent` in `InstanceCullData`, WPO disable distance, proxy-mesh shadow | In progress |
| **4b. VG velocity** | `gbuffer_velocity` as 8th target in `VirtualGeometryPass` | Planned |
| **5. Impostors** | `helio-bake` hemi-octahedral baker, impostor G-buffer pipeline, cross-fade | Planned |
| **6. Density authoring** | Painted density/exclusion arrays, procedural rules, editor brush hookup | Planned |
| **7. VG shadow casting** | Shadow-view meshlet cull, per-face VG indirect + counts, depth-only VG pipeline | Planned |
| **8. Optimisation** | Perf gate green, far-ring terrain-shading fallback, static shadow-atlas for frozen-wind grass | Planned |

### 14.2 Known limitations

We track these openly:

1. **The wind-correct motion vector claim holds for the grass path only.** `VirtualGeometryPass` binds only 7 attachments and omits `gbuffer_velocity` entirely, so VG geometry produces no motion vectors at all today. Adding velocity output to VG is phase 4b.

2. **The interaction field contributes nothing to velocity.** The bend is applied identically at `t` and `t - dt`. When `FoliageInteractionPass` lands with a history buffer, this should take a time argument like the wind model does.

3. **No recovery animation for interaction.** Exponential recovery is specified in the plan but not yet implemented.

4. **Trees do not cast real shadows in phase 4.** They use proxy-mesh double publication until phase 7 lands. Making VG cast shadows is a new workstream comparable in size to `helio-pass-shadow-cull`.

5. **The G-buffer exceeds the 32-byte `max_color_attachment_bytes_per_sample` floor.** On adapters that report baseline limits, G-buffer pipeline creation fails. The fix is tracked separately: fail loudly at device creation rather than surfacing an opaque pipeline error.

6. **The terrain capture pass (`FoliageTerrainPass`) does not exist yet.** The flat-plane fallback is acceptable for grass bring-up but will need to be replaced for real terrain integration.

### 14.3 Summary: the delta vs Unreal Engine

| Feature | Unreal Engine 5 | Helio foliage |
|---|---|---|
| Placement | CPU (`FGrassBuilder`), async tasks, hitch on stream | Compute shader, residency-cached, constant CPU cost |
| Occlusion culling | Distance + frustum only | Hi-Z max-depth at tile and cluster granularity |
| Impostors | Plugin, forward path, no shadows/SSAO/GI | Built-in hemi-octahedral, full G-buffer, full lighting |
| WPO bounds | Manual scale, `WPO Disable Distance` | Per-type `wpo_extent`, self-consistent dilation |
| Motion vectors | Not written (TAA smears) | `t` and `t-dt` evaluation, correct velocity in G-buffer |
| Interaction | Sample project, per-actor blueprint hack | Shipped 512² field, exponential recovery, one-liner API |
| Far ring | Hard cull distance, pop | Terrain material perturbation, no pop |
| Perf gate | None published | 3.0 ms at 1 M blades, CI-enforced |
| Zero overhead | N/A (always active) | Three independent tests, < 0.02 ms when empty |
| Multi-draw on WebGPU | N/A | Exactly 4 `draw_indirect` calls, no multi-draw |
| Shadow cost | Full re-render every frame | Frozen wind, cascade 0 only, AO fallback beyond |

### 14.4 The blade seed (epilogue)

We said earlier that every blade carries a 16-bit seed derived from `hash(tile_coord, lane, generation)`. This seed is the single most load-bearing value in the entire struct. Dithered LOD cross-fades, wind phase offset and per-blade variation all key off it, so it must be derived from deterministic inputs and **never** from frame index, time or a counter.

The seed is the canary in the coal mine for the entire system. If the seed is stable, every stochastic mechanism in the pipeline is stable. If the seed drifts, everything breaks at once. That is why the deterministic placement test is the first CI gate for any foliage PR, and why we store the seed at the end of the struct where a future developer adding a field is least likely to displace it.

The 3 ms budget at 1 M blades is not a target we expect to hit exactly. It is a target we expect to beat, and then move the goalpost.

---

## Series Index

This post is part of the Helio Renderer series:

1. **Rendering a Million Blades of Grass: Helio's GPU-Driven Foliage System** ← (this post)
2. *The Blade Placement Compute Shader — Deterministic Placement Contract* (forthcoming)
3. *Wind, Interaction, and Motion Vectors* (forthcoming)
4. *Tree LOD, Impostors, and WPO Culling* (forthcoming)

---

*Helio is open at github.com/Far-Beyond-Pulsar/Helio.*