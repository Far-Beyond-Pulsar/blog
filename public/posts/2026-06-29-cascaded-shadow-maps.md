---
title: "Cascaded Shadow Maps: From Matrix Compute to PCSS Filtering"
date: "2026-06-29"
author: "Tristan Poland"
tags: ["renderer", "wgpu", "rust", "helio", "shadows", "csm", "pcss", "gpu", "compute"]
description: "A complete walkthrough of Helio's shadow pipeline — GPU matrix generation for point/directional/spot lights, the 256-layer shadow atlas with GPU-driven dirty tracking, per-face frustum culling, and PCSS soft shadows with Vogel disk sampling."
thumbnail: /post_thumb/shadows.png
---

## Why Shadow Mapping Is Never Simple

Shadow mapping is one of those problems that sounds solved on paper but unravels as soon as you try to ship it. The basic algorithm is a page and a half in any graphics textbook: render depth from the light, sample that depth in the shading pass, compare. Straightforward. The trouble is that "straightforward" assumes a single stationary light, a static scene, no quality requirements, and unlimited precision.

Real scenes have a dozen lights of three different types, each with different projection requirements. Objects move. Cameras move. Shadows need to be soft, stable under TAA, and they need to work at 4K without looking like a checkerboard of self-shadowing artifacts. And all of this has to happen without introducing a CPU bottleneck — which means the GPU has to own the shadow pipeline the same way it owns everything else in Helio.

This post is a walkthrough of that pipeline. We'll cover how shadow matrices are computed entirely on the GPU (one thread per light, with per-type branching for point, directional, and spot lights), how the 256-layer shadow atlas works with GPU-driven dirty tracking, how per-face frustum culling compacts draw calls without CPU readback, and how the PCSS filtering pipeline produces soft shadows that play nicely with temporal antialiasing.

---

## GPU Matrix Computation: One Thread Per Light

In a traditional renderer, shadow matrix computation is CPU work. For each shadow-casting light, the CPU computes a light-space view-projection matrix (or six, for point lights). For directional lights with cascaded shadow maps, the CPU computes per-cascade frusta, sphere-fits bounding spheres, and texel-snaps the result. This is not expensive in isolation, but it's per-light work that scales linearly and competes for CPU time with everything else.

Helio does this on the GPU. The `shadow_matrices.wgsl` compute shader runs one thread per light. Each thread reads the light's parameters from a storage buffer, computes the appropriate matrix (or matrices) based on the light type, and writes the result into a pre-allocated buffer of `GpuShadowMatrix` structs:

```wgsl
@compute @workgroup_size(64)
fn compute_shadow_matrices(@builtin(global_invocation_id) gid: vec3u) {
    let light_idx = gid.x;
    if light_idx >= params.light_count { return; }

    let light = lights[light_idx];
    if light.shadow_index == 0xFFFFFFFFu { return; }

    if light.light_type == LIGHT_TYPE_POINT {
        compute_point_light_matrices(light_idx, light.position_range.xyz, light.position_range.w);
    } else if light.light_type == LIGHT_TYPE_DIRECTIONAL {
        compute_directional_cascades(light_idx, light.direction_outer.xyz);
    } else if light.light_type == LIGHT_TYPE_SPOT {
        compute_spot_matrix(light_idx, light.position_range.xyz,
            light.direction_outer.xyz, light.position_range.w, light.direction_outer.w);
    }
}
```

The dispatch is trivial: one workgroup per light, thread count equals light count. The shader handles three light types with different matrix counts:

**Spot lights** produce a single perspective matrix. The shader extracts the outer cone angle from the light's `cos(outer_angle)` field, clamps it to a reasonable FOV range, and builds a standard perspective projection:

```wgsl
fn compute_spot_matrix(light_idx: u32, position: vec3f, direction: vec3f,
                       range: f32, cos_outer: f32) {
    let base = lights[light_idx].shadow_index;
    let dir = normalize(direction);
    let outer_angle = acos(cos_outer);
    let fov = clamp(outer_angle * 2.0, PI * 0.25, PI - 0.01);

    let up = select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0),
        abs(dot(dir, vec3f(0.0, 1.0, 0.0))) < 0.99);
    let view = mat4_look_at_rh(position, position + dir, up);
    let proj = mat4_perspective_rh(fov, 1.0, 0.05, max(range, 0.1));

    shadow_mats[base].mat = proj * view;
}
```

**Point lights** compute six matrices — one per cube face. Each face uses a 90° vertical FOV (matching the cube map convention) with a far plane extended to 2.5× the light range to guarantee full spherical coverage at the corners. The six look-at views are hardcoded with carefully chosen up vectors to match the standard cubemap face layout:

```wgsl
fn compute_point_light_matrices(light_idx: u32, position: vec3f, range: f32) {
    let base = lights[light_idx].shadow_index;
    let far_plane = max(range, 0.1) * 2.5;
    let proj = mat4_perspective_rh(FRAC_PI_2, 1.0, 0.05, far_plane);

    let views = array<mat4x4f, 6>(
        mat4_look_at_rh(position, position + vec3f(1.0, 0.0, 0.0),  vec3f(0.0, -1.0, 0.0)),
        mat4_look_at_rh(position, position + vec3f(-1.0, 0.0, 0.0), vec3f(0.0, -1.0, 0.0)),
        mat4_look_at_rh(position, position + vec3f(0.0, 1.0, 0.0),  vec3f(0.0, 0.0, 1.0)),
        mat4_look_at_rh(position, position + vec3f(0.0, -1.0, 0.0), vec3f(0.0, 0.0, -1.0)),
        mat4_look_at_rh(position, position + vec3f(0.0, 0.0, 1.0),  vec3f(0.0, -1.0, 0.0)),
        mat4_look_at_rh(position, position + vec3f(0.0, 0.0, -1.0), vec3f(0.0, -1.0, 0.0)),
    );

    for (var i = 0u; i < 6u; i++) {
        shadow_mats[base + i].mat = proj * views[i];
    }
}
```

**Directional lights** are the most complex. They compute four CSM cascade matrices, and this is where the GPU really earns its keep — the computation involves unprojecting NDC frustum corners, computing per-cascade slice intervals, sphere-fitting, and texel snapping.

---

## PSSM Cascade Splits

The cascade far-plane distances are defined by the `CSM_SPLITS` constant, which must stay in sync between the WGSL shader and the Rust host code:

```rust
pub const CSM_SPLITS: [f32; 4] = [16.0, 80.0, 300.0, 1400.0];
```

These come from the Practical Split Scheme (PSSM), which blends uniform and logarithmic distribution. The formula is straightforward:

```rust
pub fn pssm_splits(near: f32, far: f32, lambda: f32) -> [f32; 4] {
    let mut splits = [0.0; 4];
    for i in 0..4 {
        let ratio = (i as f32 + 1.0) / 4.0;
        let c_uniform = near + (far - near) * ratio;
        let c_log = near * (far / near).powf(ratio);
        splits[i] = lambda * c_log + (1.0 - lambda) * c_uniform;
    }
    splits
}
```

We use `lambda = 0.5`, which gives a balanced distribution — the first cascade is tight enough to provide decent resolution on near-field geometry (16 metres), while the last cascade reaches out to the practical shadow distance (1400 metres). The 80m and 300m intermediate splits handle the mid-range where most gameplay-relevant shadows live.

The WGSL shader computes each cascade by unprojecting the camera's frustum corners, computing the near and far slice of each cascade as a mix between the camera frustum near and far planes, sphere-fitting the resulting 8 corners, and constructing an orthographic projection:

```wgsl
for (var cascade_idx = 0u; cascade_idx < 4u; cascade_idx++) {
    let t0 = clamp((prev_d[cascade_idx] - near_dist) / depth, 0.0, 1.0);
    let t1 = clamp((CSM_SPLITS[cascade_idx] - near_dist) / depth, 0.0, 1.0);

    var cc: array<vec3f, 8>;
    for (var j = 0u; j < 4u; j++) {
        cc[j * 2u]       = mix(world[j], world[j + 4u], t0);
        cc[j * 2u + 1u]  = mix(world[j], world[j + 4u], t1);
    }

    var centroid = vec3f(0.0);
    for (var i = 0u; i < 8u; i++) { centroid += cc[i]; }
    centroid /= 8.0;

    var radius = 0.0;
    for (var i = 0u; i < 8u; i++) {
        radius = max(radius, length(cc[i] - centroid));
    }
    // ... texel snapping ...
    let proj = mat4_orthographic_rh(-radius_snap, radius_snap,
        -radius_snap, radius_snap, 0.1, SCENE_DEPTH * 2.0);
    shadow_mats[base + cascade_idx].mat = proj * light_view;
}
```

The sphere-fit approach (centroid + bounding radius) is simpler than AABB fitting and avoids cascade boundary snapping when the camera rotates — the sphere rotates with the frustum, so the cascade bounds stay stable.

---

## Texel Snapping and Sub-Texel Shimmer

One of the most visible artifacts in CSM is sub-texel shimmer — as the camera moves, the cascade frustum shifts slightly, causing shadow edges to flicker. The fix is texel snapping: the cascade orthographic projection is snapped to texel-sized increments so that a static object's shadow map projection stays stable across frames.

The snap works by transforming the cascade centroid into light space, rounding its x and y coordinates to the nearest texel, and applying the offset back in world space:

```wgsl
let texel_size = (2.0 * radius) / ATLAS_TEXELS;
let radius_snap = ceil(radius / texel_size) * texel_size;

let light_view_raw = mat4_look_at_rh(centroid - dir * SCENE_DEPTH, centroid, up);
let centroid_ls_v4 = light_view_raw * vec4f(centroid, 1.0);
let centroid_ls = centroid_ls_v4.xyz / centroid_ls_v4.w;
let snap = texel_size;
let snapped_x = round(centroid_ls.x / snap) * snap;
let snapped_y = round(centroid_ls.y / snap) * snap;

let right_ws = normalize(vec3f(light_view_raw[0][0], light_view_raw[1][0], light_view_raw[2][0]));
let up_ws    = normalize(vec3f(light_view_raw[0][1], light_view_raw[1][1], light_view_raw[2][1]));
let snap_offset = right_ws * (snapped_x - centroid_ls.x) + up_ws * (snapped_y - centroid_ls.y);
let stable_centroid = centroid + snap_offset;

let light_view = mat4_look_at_rh(stable_centroid - dir * SCENE_DEPTH, stable_centroid, up);
```

This makes the cascade orthographic projection shift in discrete texel-sized steps rather than continuously. The result is that static geometry in shadow maps stays pixel-identical across frames, eliminating the shimmer. It also rounds the cascade radius up to the nearest texel boundary so the frustum is always fully covered — without this, the snapping could clip geometry that was previously just inside the cascade.

---

## The 256-Layer Shadow Atlas

All shadow faces — 6 per point light, 4 per directional, 1 per spot — are packed into a single `Depth32Float` texture array with 256 layers. Each face is `SHADOW_RES × SHADOW_RES` texels (512×512 in the current config). The atlas is pre-allocated at engine init and never resized:

| Property     | Value                                         |
|--------------|-----------------------------------------------|
| Format       | `Depth32Float`                                |
| Resolution   | `SHADOW_RES × SHADOW_RES` per face            |
| Array layers | `MAX_SHADOW_FACES` (256)                      |
| VRAM         | ~256 MB at 1024 px (constant, pre-allocated)  |

The 256-face limit comes from the math: 42 point lights × 6 cube faces = 252, plus 4 CSM cascades slots, rounded up to 256. That's more lights than any scene we expect to ship, and the atlas memory is constant regardless of how many faces are actually in use — it's just a pre-allocation.

The VRAM footprint depends on face resolution. At 1024×1024 per face with `Depth32Float` (4 bytes per texel), each face is 4 MB. 256 faces × 4 MB = 1024 MB. That's steep, but we run at 512×512 by default — 256 faces × 1 MB = 256 MB. Acceptable for a GPU-driven renderer targeting high-end PCs. The resolution per face is configurable at engine startup.

---

## GPU Dirty-Face Detection

The shadow atlas is cached across frames whenever possible. The key insight is that most shadow faces don't change most frames — the +X face of a point light doesn't need re-rendering just because an object moved on the -X side. Tracking this on the CPU would require per-face dependency graphs or shadow-map comparison. We do it on the GPU with hashing.

When the matrix compute shader finishes computing a light's matrices, it hashes the 6 matrix slots (4 real cascades + 2 identity-filled for directional lights) using FNV-1a:

```wgsl
fn fnv_hash_mat(m: mat4x4f) -> u32 {
    var hash: u32 = 2166136261u;
    for (var col = 0u; col < 4u; col++) {
        for (var row = 0u; row < 4u; row++) {
            let bits = bitcast<u32>(m[col][row]);
            hash ^= (bits & 0xFFu);
            hash = hash * 16777619u;
            hash ^= ((bits >> 8u) & 0xFFu);
            hash = hash * 16777619u;
            hash ^= ((bits >> 16u) & 0xFFu);
            hash = hash * 16777619u;
            hash ^= ((bits >> 24u) & 0xFFu);
            hash = hash * 16777619u;
        }
    }
    return hash;
}
```

The computed hash is compared against the previous frame's hash stored in `shadow_hashes[light_idx]`. If it changed — meaning the light moved, or the camera moved causing the CSM cascades to recompute — the shader atomically sets a dirty flag:

```wgsl
let new_hash = fnv_hash_mats_6(base_idx);
let old_hash = shadow_hashes[light_idx];

if new_hash != old_hash {
    shadow_hashes[light_idx] = new_hash;
    atomicStore(&shadow_dirty[light_idx], 1u);
}
```

This produces a per-face dirty mask in `shadow_dirty` that the render pass reads indirectly. No CPU readback, no CPU synchronization — just a GPU-side atomic store that signals which faces need re-rendering.

---

## Static vs Dynamic Atlas Split

The shadow system maintains two separate atlases: a *static* atlas for objects that never move (terrain, buildings, static props) and a *dynamic* atlas for movable objects (characters, vehicles, physics debris).

**Static objects** are shadowed once and cached until the scene topology changes (objects added or removed) or a light moves. The `static_objects_generation` counter increments on topology change, and the render pass checks `self.static_atlas_cache_gen != Some(static_gen)` to decide whether to re-render. When re-rendering, all static geometry is drawn with `LoadOp::Clear` — it's a full rebuild, but it happens infrequently.

**Movable objects** are handled per-frame when they move. The `movable_objects_generation` counter increments every time any movable object's transform changes. The render pass checks this counter as an O(1) gate before entering the dynamic atlas path. Inside that path, the GPU dirty bits (computed by the `ShadowDirtyPass` compute shader) determine which faces actually need new depth.

The Rust code in `lib.rs` tracks these as generation counters:

```rust
/// Last `static_objects_generation` rendered.
static_atlas_cache_gen: Option<u64>,

/// `movable_objects_generation` at last render.
last_movable_objects_gen: u64,
```

The execute method checks both on entry and early-exits if nothing changed:

```rust
let need_static = self.static_atlas_cache_gen != Some(static_gen)
    || shadow_count != self.last_rendered_shadow_count;

let objects_moved =
    ctx.scene.movable_objects_generation != self.last_movable_objects_gen;

if !need_static && !any_dirty_caster && !objects_moved {
    return Ok(());
}
```

This means a completely static scene with no light movement produces zero shadow-related work after the first frame — the early-return fires before any render passes are recorded.

---

## Per-Face Shadow Frustum Culling

Before any shadow geometry is rendered, a compute cull pass (`helio-pass-shadow-cull`) tests every movable instance against every dirty shadow face. This is a separate compute shader that runs with one thread per instance:

```wgsl
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let instance_idx = gid.x;
    if instance_idx >= uniforms.instance_count { return; }

    let inst = instances[instance_idx];
    let center = inst.bounds.xyz;
    let radius = inst.bounds.w;
    if radius <= 0.0 { return; }

    for (var face = 0u; face < MAX_FACES; face++) {
        if face_dirty[face] == 0u { continue; }

        let vp = shadow_matrices[face].mat;
        if sphere_in_frustum(vp, center, radius) {
            let slot = atomicAdd(&face_counts[face], 1u);
            if slot < uniforms.max_draws_per_face {
                let base = face * uniforms.max_draws_per_face;
                dst_indirect[base + slot] = src_indirect[instance_idx];
            }
        }
    }
}
```

Each thread iterates all 256 faces, but skips clean faces immediately (`if face_dirty[face] == 0u { continue; }`). For dirty faces, it does a sphere-in-frustum test against the light-space view-projection matrix using the instance's bounding sphere (center + radius from the instance data). The frustum test extracts six planes from the VP matrix and tests the sphere against each:

```wgsl
fn sphere_in_frustum(vp: mat4x4<f32>, center: vec3<f32>, radius: f32) -> bool {
    let p0 = normalize_plane(vp[3] + vp[0]);
    if dot(p0.xyz, center) + p0.w + radius < 0.0 { return false; }
    let p1 = normalize_plane(vp[3] - vp[0]);
    if dot(p1.xyz, center) + p1.w + radius < 0.0 { return false; }
    // ... continued for all 6 planes ...
    return true;
}
```

Visible instances are atomically appended to a per-face compacted indirect draw list. Each face gets up to `MAX_DRAWS_PER_FACE` (4096) draw slots, with the face-specific offset computed as `face * max_draws_per_face`. The atomic counter in `face_counts[face]` becomes the indirect draw count for that face, consumed by `multi_draw_indexed_indirect_count` in the render pass.

---

## LightDirty vs ObjectDirty: Two Render Paths

The dynamic atlas has two distinct render paths with different GPU cost profiles:

**LightDirty** (a light moved): The face is cleared entirely with `LoadOp::Clear(1.0)`, then all culled movable draws are issued. Light movement is rare in practice — typically zero per frame, occasionally 1-2 lights. The cost is proportional to the number of dirty faces (up to 6 per moving point light).

**ObjectDirty** (an object moved, light stayed put): This is the common case — a character walks across the scene. When `MULTI_DRAW_INDIRECT_COUNT` is available (Vulkan 1.2+, DX12 tier 2), we use `LoadOp::Load` to preserve the cached atlas on clean faces, then issue two `multi_draw_indirect_count` calls per face:

```rust
if self.supports_multi_draw_count {
    let mut pass = /* ... LoadOp::Load ... */;

    // 1. Depth-clear triangle (GPU count 0 or 1 from face_dirty_buf).
    pass.set_pipeline(&self.depth_clear_pipeline);
    pass.multi_draw_indirect_count(
        &self.clear_indirect_buf,
        face as u64 * 16,
        &self.face_dirty_buf,
        face as u64 * 4,
        1,
    );

    // 2. Shadow geometry (GPU count 0 or movable_draw_count).
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, bg, &[dyn_offset]);
    pass.multi_draw_indexed_indirect_count(
        &self.face_cull_indirect,
        face_offset,
        &self.face_cull_counts,
        face as u64 * 4,
        MAX_DRAWS_PER_FACE,
    );
}
```

The depth-clear triangle is a full-screen triangle rendered at depth=1.0 with `DepthCompare::Always` — it overwrites existing depth values only on faces that `face_dirty_buf` marks as dirty. The `clear_indirect_buf` contains 256 pre-allocated draw commands for this triangle, each with `{ vertex_count: 3, instance_count: 1 }`.

The shadow geometry is drawn from `face_cull_indirect`, which contains only instances that passed the per-face frustum cull. Clean faces see zero draws from both passes because their dirty and count values are both zero.

On platforms without `MULTI_DRAW_INDIRECT_COUNT` (macOS Metal, WASM), we fall back to a full `LoadOp::Clear` + draw-all path, which is functionally correct but loses the per-face granularity benefit.

---

## PCSS: From Blocker Search to PCF Filter

Shadow sampling in Helio uses Percentage-Closer Soft Shadows (PCSS) when quality settings permit. The algorithm is the standard three-step process: blocker search → penumbra estimation → PCF filter.

The `ShadowConfig` struct defines per-cascade parameters and quality presets:

```rust
pub struct CascadeConfig {
    pub split_distance: f32,
    pub depth_bias: f32,
    pub filter_radius: f32,
    pub pcss_light_size: f32,
}

pub struct ShadowConfig {
    pub cascades: [CascadeConfig; 4],
    pub enable_pcss: u32,
    pub pcss_blocker_samples: u32,
    pub pcss_filter_samples: u32,
    pub pcf_sample_count: u32,
}
```

PCSS is controlled per-cascade via `pcss_light_size`. When set to `0.0`, PCSS is disabled for that cascade and a fixed-radius PCF is used instead. This lets us use cheaper PCF for close cascades where contact-hardening matters less, and PCSS for far cascades where the penumbra estimation makes a visible difference.

The quality presets map to hardware capability:

| Quality | PCF Samples | PCSS Blocker | PCSS Filter | Light Size |
|---------|-------------|--------------|-------------|------------|
| Low     | 8           | —            | —           | 0 (PCF only) |
| Medium  | 12          | —            | —           | 0 (PCF only) |
| High    | 12          | 8            | 16          | 2-16m      |
| Ultra   | 16          | 16           | 32          | 2-16m      |

The depth bias increases per cascade to account for the coarser texel-to-world mapping at farther distances. In Low and Medium the bias starts at 0.0001 for the first cascade and goes up to 0.0003 for the last. High and Ultra use tighter biases (0.00008-0.00025) because PCSS's variable filter width masks residual self-shadowing better than fixed PCF.

---

## Vogel Disk Sampling for TAA-Friendly Noise

PCF and PCSS both require sampling the shadow map at multiple locations. Naive random sampling produces noise that fights with temporal antialiasing — TAA accumulates sample history, but random jitter changes every frame, producing ghosting and instability.

Helio uses a Vogel disk sampling pattern with per-pixel rotation. The Vogel disk distributes samples with approximately equal angular spacing and radial distance, producing a low-discrepancy pattern that converges faster than pure random. Each pixel uses a hash to rotate the disk, producing structured noise that's stable across frames when the camera and objects don't move:

```rust
/// Vogel disk uses a stable per-pixel hash so noise is static across
/// frames and TAA can accumulate it effectively.
```

The per-pixel rotation is derived from screen-space coordinates, so a static pixel looking at a static shadow will sample the same locations every frame. TAA sees zero high-frequency variation and accumulates the soft shadow without ghosting. When the camera or shadow casters move, the structured noise pattern shifts smoothly — TAA's neighbourhood clamping handles the minor residual variation without the film-grain appearance of pure random sampling.

---

## Shadow Atlas Memory

A question that comes up frequently: how much VRAM does the shadow atlas use? The answer is that it's constant:

$$256 \text{ faces} \times \text{SHADOW\_RES}^2 \times 4 \text{ bytes (Depth32Float)}$$

At 512² per face: ~256 MB. At 1024² per face: ~1 GB. Double that to account for the separate static atlas, and you're at 512 MB or 2 GB.

Two atlases at 512 MB total is acceptable for a PC target with 8+ GB of VRAM. The key property is that the cost is constant regardless of how many lights are in the scene — adding a light doesn't allocate more memory; it just activates an existing layer. The atlas is fully pre-allocated at engine init and never touched by the allocator again.

---

## Current Limitations and Future Work

The system works, but there are areas we'd like to improve:

**Cascade transition band.** The 4-cascade setup produces visible quality transitions when an object crosses from one cascade to the next. We apply a 1-texel blend region, but it's not perfect — the transition is still noticeable with high-contrast shadows. A 6-cascade layout or a more sophisticated blend (dual-weight PCF across the boundary) would help, but both increase GPU cost.

**Static atlas rebuild cost.** When a light moves, all static objects are re-rendered into the static atlas. For a scene with thousands of static shadow casters, this is a multi-millisecond hit. We could mitigate this by splitting the static atlas into per-light segments and only rebuilding the affected light's faces — the per-face dirty tracking already supports this, but the generation counter is a single global value.

**Point light sub-texel shimmer.** The texel-snapping described earlier applies only to directional CSM cascades. Point lights don't snap — their perspective projection means sub-texel shifting produces visible shimmer on nearby surfaces. Fixing this requires snapping the entire cube-map texel grid, which is more complex than the orthographic case. We're exploring a reprojection-based approach that accumulates shadow history across frames for point lights.

**Non-Depth32Float formats.** The atlas uses `Depth32Float` exclusively. Using `Depth24PlusStencil8` would shave 25% off the VRAM footprint and provide a stencil buffer for per-face masking, but wgpu's support for packed depth-stencil formats in texture arrays varies across backends. We're watching this space.

No shadow system is ever done — there's always a better cascade distribution, a cheaper filtering scheme, or a more clever caching strategy. But the current pipeline has been shipping in Pulsar for several months, and it handles everything from a single directional sun with 4 cascades to a dozen point lights with per-face culling and PCSS soft shadows. The GPU owns the shadow work, and the CPU stays out of the way.
