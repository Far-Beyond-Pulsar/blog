---
title: "Culling Done Right: Fixing What Everyone Gets Wrong About GPU Culling"
date: "2026-06-29"
author: "Tristan Poland"
tags: ["rust", "helio", "graphics", "optimization", "pulsar"]
description: "A deep technical postmortem of Helio's culling system — the critical bugs that caused objects to vanish when they shouldn't and appear when they shouldn't, the fixes that brought everything inline with AAA standards, and what a 110% occlusion-culled stat taught us about atomic counter races."
thumbnail: /post_thumb/culling.png
---

## Why Culling Matters More Than You Think

Every triangle that doesn't reach the fragment shader is a victory. This isn't just graphics-programmer mantra — it's the difference between a scene that runs at 144 fps and one that chokes at 30. On a traditional CPU-driven renderer, culling is "free" in the sense that the CPU iterates the visible set once and only issues draw calls for what passes. The cost is in the iteration loop itself: touching every object, transforming bounding volumes, evaluating plane equations. For 10,000 objects that's barely measurable. For 100,000 it's frame-budget line item. For a million it's off the table.

Helio is GPU-driven. The CPU does not iterate the object list. It uploads transforms and lets compute shaders decide what's visible. That means every culling decision — frustum, occlusion, LOD, shadow, sub-pixel — must happen in WGSL compute passes before a single indirect draw call is emitted. There is no second chance. The culling compute shader is the gatekeeper; if it lets something through that shouldn't render, the GPU pays the full rasterization cost. If it culls something that should render, the object disappears silently and nobody knows why.

This post is the complete technical history of Helio's culling system: every bug we found, every fix we applied, and every new feature we added to get from "mostly works on a good day" to "correct, tight, and measurable."

---

## The Starting Point

The original culling pipeline had exactly two passes running in sequence before the main render:

1. **cs_frustum_cull**: Transforms each instance's bounding sphere to view space, tests against the six frustum planes using `dot(n, P) + d < -radius`, writes a visible flag.
2. **cs_occlusion_cull**: Optionally, projects the sphere to screen space, samples the Hi-Z pyramid, and discards instances behind occluding geometry.

This was followed by **cs_build_indirect**, which scanned the visible flags and emitted compact `DrawIndexedIndirect` commands.

On paper, this is a standard GPU culling pipeline. It appears in talk slides from every major engine. The implementation details — the exact math in the shaders, the indexing into buffers, the number of Hi-Z samples — are what separate "looks correct in the editor demo" from "actually correct in every frame."

We had the first one. We needed the second.

---

## Bug #1: Non-Normalized Frustum Planes

The first bug was hiding in plain sight. It was in the Rust code that extracts frustum planes from the view-projection matrix. We used the standard Gribb/Hartmann extraction, which reads the plane coefficients directly from the rows of `view_proj`:

```rust
pub fn extract_frustum_planes(vp: &[[f32; 4]; 4]) -> [[f32; 4]; 6] {
    let mut planes = [[0.0f32; 4]; 6];
    // Left
    planes[0] = [vp[0][3] + vp[0][0], vp[1][3] + vp[1][0],
                 vp[2][3] + vp[2][0], vp[3][3] + vp[3][0]];
    // Right
    planes[1] = [vp[0][3] - vp[0][0], vp[1][3] - vp[1][0],
                 vp[2][3] - vp[2][0], vp[3][3] - vp[3][0]];
    // Bottom, Top, Near, Far — same pattern
    // ...
    planes
}
```

Gribb/Hartmann is efficient — it extracts all six planes with 12 subtractions and 12 additions. But it produces planes where the normal vector `(n.x, n.y, n.z)` is NOT unit length. The plane equation `dot(n, P) + d = 0` still defines the correct plane, but `dot(n, P) + d` does not equal the perpendicular distance from `P` to the plane. It equals the distance scaled by `||n||`.

The sphere-frustum test was the standard one:

```wgsl
fn sphere_visible(center: vec3<f32>, radius: f32, plane: vec4<f32>) -> bool {
    return dot(plane.xyz, center) + plane.w > -radius;
}
```

This is only correct when `plane.xyz` is unit length. When it isn't, you're comparing `scaled_dist < -radius` — the scaled distance against an unscaled radius. For planes where `||n|| > 1`, the scaled distance is larger than the true distance, causing false negatives (objects culled when they're actually visible). For planes where `||n|| < 1`, the reverse happens, causing false positives (objects passing culling when they're outside the frustum). Both directions are bad. False negatives mean holes in the render. False positives mean wasted GPU work.

The fix is one normalize call per plane after extraction, right in `extract_frustum_planes`:

```rust
for i in 0..6 {
    let inv_len = 1.0 / (planes[i][0] * planes[i][0]
                      + planes[i][1] * planes[i][1]
                      + planes[i][2] * planes[i][2]).sqrt();
    for j in 0..4 {
        planes[i][j] *= inv_len;
    }
}
```

This is the kind of bug that lives for months because the visual symptoms are subtle. Most objects in a typical scene are either squarely inside the frustum or far outside, so the boundary error only manifests for objects near the edge — exactly the objects most likely to be partially visible and the most important to get right. You'd see flickering at the screen edge on rotating cameras, assume it's a timing issue, and chase the wrong fix for days.

---

## Bug #2: Occlusion Cull Indexing Out of Bounds

This is the most dangerous bug in the entire post, and the one I am least proud of. It was a GPU memory corruption that produced random culling behavior, and it worked by accident in the simplest case.

The occlusion pass was structured as a single compute shader that iterated over `instances[]`:

```wgsl
@compute @workgroup_size(256)
fn cs_occlusion_cull(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if idx >= uniforms.instance_count { return; }
    let inst = instances[idx];

    // ... occlusion test against Hi-Z ...

    if occluded {
        // Decrement the visible count for this instance's draw call.
    }
}
```

The problem is in how it wrote the result back. The pass needed to decrement the instance count of the indirect draw call that owns this instance. In the original code, it treated every instance as its own draw call:

```wgsl
// BAD: writes to indirect[idx * 5 + 1], treating idx as a draw call index
let draw_call_idx = idx; // WRONG — only correct in persistent mode
atomicSub(&indirect[draw_call_idx * 5u + 1u], 1u);
```

In persistent mode — where every instance is its own `DrawIndexedIndirect` with `instance_count = 1` — this works. `idx` equals `draw_call_idx`, `indirect[idx * 5 + 1]` is the instance_count field of the correct draw call, and decrementing it to zero is correct.

In optimized mode — where instances are batched by (mesh, material) pair into fewer draw calls with higher instance counts — this writes PAST THE END of the indirect buffer. If 10,000 instances are batched into 400 draw calls, `indirect[9999 * 5 + 1]` is writing way beyond the 400-draw-call buffer. On the GPU, that's a write to whatever memory follows the indirect buffer — possibly the instance buffer, the Hi-Z texture descriptor, or the command buffer itself. The behavior is non-deterministic, driver-dependent, and produces symptoms that look like "culling randomly breaks when batching is enabled."

The fix is to iterate over draw calls, not instances. Each draw call has a `first_instance` field. Read the representative instance through that:

```wgsl
@compute @workgroup_size(64)
fn cs_occlusion_cull_drawcalls(@builtin(global_invocation_id) id: vec3<u32>) {
    let dc_idx = id.x;
    if dc_idx >= uniforms.draw_call_count { return; }
    let dc = draw_calls[dc_idx];
    if dc.instance_count == 0u { return; }

    // Use the first instance as the representative for this batch.
    let rep_inst = instances[dc.first_instance];
    let sphere = rep_inst.bounds;

    // ... occlusion test ...

    if occluded {
        // Bounds-safe: dc_idx is always < draw_call_count
        atomicSub(&indirect[dc_idx * 5u + 1u], 1u);
    }
}
```

The root cause was architectural: the original pass was designed for a world where one instance = one draw call, and the indexing shortcut was never updated when batching was added. We caught it because the occlusion culling stats (more on those later) started showing "occluded" counts that fluctuated wildly between frames — sometimes 80%, sometimes 2%, sometimes the counter wrapped past zero and showed millions. That's the signature of GPU memory corruption: random bits overwriting an atomic counter.

---

## Bug #3: Wrong Near-Depth in Occlusion Test

The Hi-Z occlusion test needs to compute the nearest depth of the bounding sphere — the closest point on the sphere surface to the camera. This depth is used to determine which MIP level of the Hi-Z pyramid to sample. If the depth is wrong, you either sample too coarse a MIP (over-occlude: objects disappear behind thin geometry) or too fine a MIP (under-occlude: objects render when they shouldn't).

The original code computed the near depth like this:

```wgsl
// WRONG — this is not the sphere's nearest depth
let clip = camera.view_proj * vec4<f32>(inst.bounds.xyz, 1.0);
let near_z_norm = clip.z / clip.w;
let near = near_z_norm * (uniforms.z_near / clip.w);
```

This is mathematically nonsensical. `clip.z / clip.w` is the NDC depth of the sphere center. Multiplying by `(near / clip.w)` scales by a perspective factor and the near plane distance, but does not account for the sphere's radius or the direction from camera to center. The actual nearest point on the sphere surface to the camera is:

```
near_ws = center - normalize(to_camera) * radius
```

Where `to_camera = camera_pos - center`. You then project `near_ws` to NDC to get the correct near depth.

```wgsl
// CORRECT
let to_camera = camera_position - center;
let dist_to_center = length(to_camera);
let dir_to_camera = to_camera / dist_to_center;
let near_ws = center - dir_to_camera * radius;

let near_clip = camera.view_proj * vec4<f32>(near_ws, 1.0);
let near_z = near_clip.z / near_clip.w;
```

This was a pure math error — the kind where you stare at the original expression, suspect it's wrong, but can't immediately articulate why. You know the sphere's nearest depth should be shallower (closer to the camera) than the center's depth, but the wrong expression produces something that looks approximately right in many cases. The visual symptom was objects popping in and out when they passed behind thin occluders — tree trunks, pillars, railings. The near depth was too deep (too far from camera), so the Hi-Z sample read a too-coarse MIP level, which stored the maximum depth over a larger area, which was more likely to occlude the object.

---

## Bug #4: Single-Tap Hi-Z Sample

The original Hi-Z test computed the sphere's screen-space UV and sampled the Hi-Z texture at exactly one point:

```wgsl
let uv = project(camera, center);
let z_sample = textureSampleLevel(hiz_tex, hiz_sampler, uv, mip_level);
if near_z > z_sample { occluded = true; }
```

A single sample at the sphere center is fine for spheres that project to a small screen footprint. For large spheres that cover many pixels, the center sample can miss small occluders at the edges of the sphere's screen-space rectangle. A tree branch that covers 15 pixels in the corner of a 500-pixel sphere will not be caught by a center tap — the center sample lands on clear sky, the sphere passes the occlusion test, and the tree branch renders behind it.

The fix is a 4-tap conservative test that samples the four corners of the bounding rectangle and takes the farthest depth:

```wgsl
let rect = compute_screen_rect(center, radius, camera.view_proj, viewport_size);
let d00 = textureSampleLevel(hiz_tex, hiz_sampler, rect.min, mip_level).r;
let d10 = textureSampleLevel(hiz_tex, hiz_sampler, vec2(rect.max.x, rect.min.y), mip_level).r;
let d01 = textureSampleLevel(hiz_tex, hiz_sampler, vec2(rect.min.x, rect.max.y), mip_level).r;
let d11 = textureSampleLevel(hiz_tex, hiz_sampler, rect.max, mip_level).r;

let farthest = max(max(d00, d10), max(d01, d11));
if near_z > farthest { occluded = true; }
```

The four corners bound the sphere's entire screen projection. Any occluder that overlaps the sphere's screen-space footprint will intersect at least one corner sample. Taking the maximum (farthest) depth across all four guarantees a conservative test: we only mark the sphere occluded if it is behind *all* occluding geometry at its projected corners.

The cost is four texture samples instead of one. With bilinear filtering and a well-cached Hi-Z texture, the difference is negligible — approximately 0.01ms per frame on a 3080.

---

## Bug #5: VG LOD Used Instance Bounds

The virtual geometry system (meshlet-based, Nanite-like) has its own culling pass that runs before the G-buffer. For each meshlet, it tests the bounding cone for backface culling and the bounding sphere for frustum culling, then selects a LOD level based on screen coverage.

The LOD selection code was:

```wgsl
let obj_radius = inst.bounds.w;  // BUG: instance bounds, not meshlet bounds
let screen_radius = obj_radius * f32(viewport_size.y) / clip_pos.z;
let lod = select_lod(screen_radius, meshlet.lod_error);
```

`inst.bounds.w` is the bounding sphere radius of the *entire object*, not the individual meshlet. Every meshlet from a given object used the same radius and therefore selected the same LOD level, regardless of whether the meshlet covered 5% of the screen or 0.1%. The per-meshlet granularity that justifies the entire VG architecture was completely defeated.

The fix is to use the meshlet's own world-space bounding sphere radius, which is precomputed at upload time and stored in `meshlet.bounding_sphere.w`:

```wgsl
let meshlet_radius = meshlet.bounding_sphere.w;
let screen_radius = meshlet_radius * f32(viewport_size.y) / clip_pos.z;
// But we need the meshlet's world-space center too, not just the instance center.
```

This requires transforming the meshlet's local-space bounding sphere to world space using the instance's model matrix — an extra `mat4 * vec4` per meshlet. On a few thousand meshlets, the cost is a rounding error. The benefit is that meshlets on the periphery of an object (high detail, small screen footprint) correctly LOD down while the core meshlets stay at full resolution.

---

So far, every section has been about fixing things that were broken. The remaining sections are about things we added that weren't missing — they were never there at all, and the difference they make is measurable.

---

## Two-Tier Frustum Culling: AABB + Sphere

Sphere frustum culling is cheap and conservative. One dot product per plane, six planes, done. But spheres are loose bounding volumes for elongated objects — a spear, a light pole, a long crate. The sphere overestimates the volume by a large margin, and the result is false positives: objects that pass frustum culling but whose mesh doesn't actually overlap the frustum.

The AABB test is tighter. For each plane, pick the corner farthest along the plane normal (the "n-vertex"), and test that single point:

```wgsl
fn test_aabb_vs_plane(aabb_min: vec3<f32>, aabb_max: vec3<f32>, plane: vec4<f32>) -> bool {
    // Pick the corner that extends farthest along the plane normal.
    let n = plane.xyz;
    let px = select(aabb_min.x, aabb_max.x, n.x > 0.0);
    let py = select(aabb_min.y, aabb_max.y, n.y > 0.0);
    let pz = select(aabb_min.z, aabb_max.z, n.z > 0.0);
    let corner = vec3(px, py, pz);
    return dot(n, corner) + plane.w > 0.0;
}
```

If the n-vertex is outside the plane, the entire AABB is outside. This is the standard "n-vertex AABB test" used by every production engine — it tests six points (one per plane) instead of the sphere's six dot products, and the result is strictly tighter. We run the sphere test first (three FMAs per plane), and if the sphere passes, we run the AABB test. If the AABB fails, the object is culled. If the AABB passes (or the object has no precomputed AABB), the sphere result stands.

The AABB is precomputed from the mesh's vertex positions and stored alongside the bounding sphere in the instance data:

```rust
pub struct GpuInstanceData {
    pub model:          [f32; 16],
    pub normal_mat:     [f32; 12],
    pub bounds:         [f32;  4],  // sphere: [cx, cy, cz, radius]
    pub aabb_min:       [f32;  3],  // local-space AABB
    pub aabb_max:       [f32;  3],
    pub _pad:           [f32;  2],
    pub mesh_id:        u32,
    pub material_id:    u32,
    pub flags:          u32,
    pub lightmap_index: u32,
}
```

The local-space AABB is transformed to world space by multiplying min/max by the model matrix in the shader. For non-uniform scales, this can produce a skewed AABB that overestimates the world-space volume — but it's still tighter than the sphere because the sphere was already computed from the same skewed transform.

We keep the sphere fallback for objects with degenerate AABBs (single-triangle meshes, flat decals) where the AABB is a thin slab and the n-vertex test is unreliable.

---

## Sub-Pixel Culling

Sub-pixel culling is the simplest feature in this post and one of the most effective. Before the frustum test, we compute the screen-space radius of the bounding sphere:

```wgsl
let clip_pos = camera.view_proj * vec4<f32>(center, 1.0);
let screen_radius = radius * f32(viewport_size.y) / clip_pos.w;
if screen_radius < 1.0 { return; }  // Culled: smaller than one pixel
```

An object that projects to less than one pixel will contribute at most a single fragment. The rasterizer still has to process its entire mesh, transform every vertex, and for a multi-draw batching scenario, the entire draw call pays the cost. Culling these objects before they reach the indirect buffer eliminates a large class of distance-band artifacts — the far-away objects that flicker as the camera moves because their projected size oscillates around the pixel boundary.

We use `< 1.0` for the threshold, which is conservative. Sub-pixel objects are genuinely invisible at native resolution. On a 1080p display with a 60-degree horizontal FOV, this culls objects beyond approximately `radius * 540` world units from the camera. For an object with a 1-meter bounding sphere, that's 540 meters — far enough that you'd never notice.

---

## Per-Meshlet Hi-Z Occlusion in VG Pass

The main occlusion pass runs against instance bounding spheres. For large meshes, this is conservative — the instance sphere might be visible while most of its meshlets are behind geometry. The VG pass operates at the meshlet granularity, so it has the data to do per-meshlet occlusion testing.

Each meshlet has its own world-space bounding sphere (computed from the instance transform and the meshlet's local bounds). The VG occlusion pass iterates over meshlets rather than instances and runs the same 4-tap Hi-Z test:

```wgsl
@compute @workgroup_size(256)
fn cs_vg_occlusion_cull(@builtin(global_invocation_id) id: vec3<u32>) {
    let idx = id.x;
    if idx >= uniforms.meshlet_count { return; }
    let m = meshlets[idx];
    let inst = instances[m.instance_idx];

    let ws_center = inst.model * vec4<f32>(m.local_bounds.xyz, 1.0);
    let ws_radius = length(inst.model[0].xyz) * m.local_bounds.w; // scale-aware

    // 4-tap Hi-Z test
    let rect = compute_screen_rect(ws_center.xyz, ws_radius, camera.view_proj, viewport_size);
    // ...
}
```

Meshlets that fail the occlusion test are marked invisible and skip the atomic compaction step. Only meshlets that pass both frustum and occlusion tests reach the indirect buffer. For a high-poly mesh where 60% of meshlets are behind occluding geometry, this is a direct 60% reduction in vertex throughput in the depth prepass and G-buffer.

---

## Per-Face Shadow Frustum Culling

Shadow mapping has a scaling problem. Each shadow-casting light needs to render the scene from its perspective. For a point light with six shadow faces, every movable instance must be considered for every face. Six faces × 1000 instances = 6000 visibility tests per frame, per light.

Before this feature, the shadow pass simply rendered all shadow-casting instances into all shadow faces. The GPU could clip geometry outside the frustum at the vertex shader level, but the vertex shader was still invoked for every instance in every face — six times for point lights.

The fix is a new compute pass — one workgroup per shadow face — that runs frustum culling on the shadow-casting instance list and builds a compacted indirect buffer per face:

```wgsl
@compute @workgroup_size(64)
fn cs_shadow_frustum_cull(@builtin(workgroup_id) wid: vec3<u32>) {
    let face_index = wid.x;
    let face = shadow_faces[face_index];
    let count = count_visible_in_face(face, shadow_instances, uniforms.shadow_instance_count);

    // Compact visible instances into face-specific indirect buffer
    if count > 0u {
        write_indirect_for_face(face_index, count);
    }
}
```

Each face's indirect buffer is consumed by the shadow render pass via `multi_draw_indexed_indirect`. The result: for a point light where each face sees roughly 1/6 of the scene, the shadow vertex cost drops by ~5-6x. The per-face culling pass costs a few microseconds on the GPU. The savings in vertex throughput are measured in milliseconds.

This is available as a separate crate — `helio-cull-shadow` — that replaces the default "render everything everywhere" behavior. It integrates with the existing shadow atlas system and the dirty-face tracking that only re-renders shadow faces when the light or scene changes.

---

## Static HiZ PVS Integration

The per-frame occlusion pipeline tests every visible instance against the Hi-Z pyramid derived from the current frame's depth buffer. This is effective, but it only works for objects that are occluded by *visible* geometry — geometry that has already been rendered to the depth buffer in the current frame. Objects behind the camera or occluded by static architecture that hasn't been drawn yet cannot be tested.

The static PVS (potentially visible set) solves this by pre-baking visibility into a 3D voxel grid at bake time. Each voxel stores a bitmask of which static objects are visible from that cell. At runtime, the camera's position indexes into the grid, and the visible set is read directly.

Helio's implementation bakes the PVS into a 3D texture using a rasterization-based approach: for each cell in the grid, render the static scene from that cell's position into six cubemap faces, record which objects appear in any face. The output is a `visibility_grid` with dimensions like 64×64×32 covering the playable area.

At runtime, the static PVS is connected to the occlusion pipeline through a shared visible-flag buffer:

```rust
// In the culling prepare phase:
let cell = world_to_grid(camera_position);
let pvs_mask = visibility_grid[cell];
for each static instance:
    if (pvs_mask & (1 << instance.pvs_bit)) == 0:
        mark_occluded(instance);
```

This is camera-independent: the PVS says "is this object visible from anywhere in this cell?" rather than "is this object visible in this exact view?" So it's conservative — it will not cull an object that *might* be visible from the current cell position. But it reliably culls objects that are definitely behind multiple walls, around corners, or in disconnected rooms.

The integration with the Hi-Z occlusion pipeline is additive: the PVS is evaluated first (zero GPU cost per frame), and the Hi-Z test runs on whatever remains. Objects that pass the PVS but fail Hi-Z are still occluded. Objects that fail PVS are culled before the Hi-Z pass even runs.

---

## GPU Culling Statistics Overlay

The final piece is what ties all of this together and prevents the next generation of bugs. The culling statistics overlay tracks 8 atomic counters across all culling passes:

| Index | Counter | Description |
|-------|---------|-------------|
| 0 | `total_instances` | Instances submitted to the culling pipeline |
| 1 | `passed_frustum` | Instances after frustum culling |
| 2 | `passed_occlusion` | Instances after occlusion culling |
| 3 | `subpixel_culled` | Instances culled by sub-pixel test |
| 4 | `shadow_instances` | Instances submitted to shadow culling |
| 5 | `shadow_passed` | Instances after shadow frustum culling |
| 6 | `vg_meshlets` | Meshlets submitted to VG culling |
| 7 | `vg_occluded` | Meshlets occluded in VG pass |

The counters are stored in a single `atomic<u32>` staging buffer. Each pass increments the relevant counters via `atomicAdd`. At the end of the frame, the buffer is read back to the CPU via a `copy_buffer_to_buffer` + `map_async`:

```rust
pub fn read_culling_stats(&self) -> Option<CullingStats> {
    let buf = self.stats_readback.recv()?;
    let mapped = buf.slice(..).get_mapped_range();
    let counts: &[u32; 8] = bytemuck::from_bytes(&mapped);
    Some(CullingStats {
        total_instances:  counts[0],
        passed_frustum:   counts[1],
        passed_occlusion: counts[2],
        subpixel_culled:  counts[3],
        shadow_instances: counts[4],
        shadow_passed:    counts[5],
        vg_meshlets:      counts[6],
        vg_occluded:      counts[7],
    })
}
```

The debug overlay renders the stats as a table in the top-right corner:

```
CULLING STATS
─────────────────────
Total inst:    14,382
Pass frustum:  11,247  (78.2%)
Pass occ:       5,891  (52.4% of frustum)
Subpixel:       1,036  ( 7.2%)
─────────────────────
Shadow inst:    3,281
Shadow pass:      684  (20.8%)
─────────────────────
VG meshlets:   42,176
VG occ:        28,411  (67.4%)
```

This overlay is how we discovered the 110% bug.

### What the 110% Bug Taught Us

When we first deployed the stats overlay, the "occluded" percentage was showing values above 100% — sometimes 110%, 130%, even 200%. The sum of "passed frustum," "occluded," and "subpixel" exceeded "total instances" by a wide and varying margin. This is impossible. Every instance is in exactly one state after culling: passed, occluded, or subpixel-culled. The sum must equal the total.

The root cause was a counter index collision between the two culling passes — the main occlusion pass and the VG meshlet occlusion pass. Both passes used the same stats buffer but indexed into it with hardcoded constants that happened to overlap:

```wgsl
// Main occlusion pass
stats[1] = some_value; // "passed_frustum" is index 1
```

```wgsl
// VG meshlet pass (different shader, different author)
stats[1] = some_value; // Collision — also writes to "passed_frustum"
```

The stats buffer had no per-pass offset because the two passes were written independently and the shared counter layout was never documented. The main pass wrote its frustum count to index 1, and the VG pass wrote its meshlet count to index 1 — same memory location, different meaning, silently corrupting both values.

The fix was to assign each pass a reserved index range and validate at startup that no ranges overlap:

```rust
const MAIN_OCC_START: u32 = 0;
const VG_OCC_START:   u32 = 4;
const SHADOW_START:   u32 = 6;

fn validate_ranges() {
    assert!(MAIN_OCC_START + 4 <= VG_OCC_START, "Main occ range overlaps VG range");
    assert!(VG_OCC_START + 2 <= SHADOW_START, "VG range overlaps shadow range");
}
```

The lesson: atomic counters and staging buffers are powerful debugging tools, but they are also code like any other resource. Shared state between passes requires explicit range allocation and validation. If you don't enforce it at the API level, it will break silently and produce numbers that look plausible enough to trust.

---

## What It Looks Like Now

The current culling pipeline, in order, is:

1. **Static PVS test** (CPU, zero GPU cost) — cull instances definitely behind geometry
2. **Sub-pixel cull** — cull instances smaller than 1 pixel
3. **AABB + sphere frustum test** — n-vertex test with sphere fallback
4. **Main Hi-Z occlusion** — 4-tap conservative, projected bounding rect
5. **Shadow frustum cull** — per-face indirect buffer compaction for shadow casters
6. **VG meshlet frustum + occlusion** — per-meshlet test, LOD selection, atomic compaction
7. **Stats readback** — 8 counters accumulated, displayed on overlay

Total GPU time for all culling passes: 0.3–0.8ms depending on instance count and scene complexity. The savings in avoided rendering: typically 50–70% of the scene geometry, higher in dense indoor environments.

The bugs we fixed were not unique to Helio. They are the standard mistakes that GPU culling implementations make — the non-normalized planes, the index collision, the single-tap Hi-Z, the wrong perspective math. If you are building a GPU-driven renderer and your culling pass has any of these patterns, you have the same bugs, whether you've noticed them yet or not.

Culling is part of Helio, open at [github.com/Far-Beyond-Pulsar/Helio](https://github.com/Far-Beyond-Pulsar/Helio).
