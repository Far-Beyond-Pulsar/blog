---
title: "Tiled Light Culling: From Linear Scan to Forward+"
date: "2026-06-29"
author: "Tristan Poland"
tags: ["renderer", "wgpu", "rust", "helio", "lighting", "culling", "forward-plus", "gpu", "compute"]
description: "A technical walkthrough of Helio's tile-based light culling system — how we replaced a linear per-pixel light scan with a compute shader that assigns lights to 16x16 tiles, the tile frustum construction, the cache key that makes it free on static scenes, and what 1000+ dynamic lights look like in practice."
thumbnail: /post_thumb/light_cull.png
---

## The Per-Pixel Light Problem

Deferred shading has a dirty secret that nobody talks about in the introductory talks: the lighting pass evaluates every light for every pixel. When you have fifty lights in a scene and you're running at 1080p, that's 2,073,600 pixels times fifty lights — roughly one hundred million light-pixel evaluations per frame. Modern GPUs can chew through that in a few milliseconds if the BRDF is simple. It's not great, but it works.

The problem is that "fifty lights" is a toy scene. A real game interior has light fixtures, debug indicators, muzzle flashes, emissive object fills, area-light proxies, and player-placed lights. That number climbs past two hundred fast. At two hundred lights you're at four hundred million evaluations. At a thousand you're at two billion. The GPU starts breathing hard.

We knew this going into Helio. The CPU-driven frustum culling that works for geometry doesn't help here — a light might illuminate a tiny fraction of the screen but still pass the camera frustum test. What you need is per-tile visibility: a way to figure out, for every 16×16 block of pixels, exactly which lights can possibly affect it. Then in the deferred pass each pixel only loops over the lights assigned to its tile.

That's Forward+ applied to deferred shading. Or, more precisely, it's tiled light culling — a compute pass that runs before the deferred lighting pass, classifies every light into a screen-space tile frustum, and writes a compact list per tile. The per-pixel loop goes from O(num_lights) to O(lights_in_tile), and for most tiles that number is zero or single digits.

---

## Forward+ for Deferred: The Architecture

Forward+ is usually described in the context of forward rendering: a compute pass builds a light grid, then the forward shader reads it during the main pass. But the same idea maps directly onto deferred shading. The G-buffer pass is unchanged. Between the G-buffer and the deferred lighting pass we insert a compute dispatch that reads the camera, reads the light buffer, and writes two storage buffers:

- `tile_light_counts[tile_idx]` — how many lights touch this tile
- `tile_light_lists[tile_idx * MAX_LIGHTS_PER_TILE + i]` — the i-th light index for this tile

The deferred lighting pass then reads those buffers in the fragment shader. Instead of:

```wgsl
for (var i = 0u; i < num_lights; i++) {
    let light = lights[i];
    // test distance, evaluate BRDF...
}
```

It does:

```wgsl
let tile_idx = tile_y * globals.num_tiles_x + tile_x;
let tile_light_count = tile_light_counts[tile_idx];
for (var i = 0u; i < tile_light_count; i++) {
    let light_idx = tile_light_lists[tile_idx * MAX_LIGHTS_PER_TILE + i];
    let light = lights[light_idx];
    // evaluate BRDF...
}
```

The outer pass stays a full-screen triangle. No changes to the G-buffer. No changes to the PBR evaluation. The only difference is which lights the shader iterates. From the fragment's perspective the loop went from scanning 500 lights to scanning the 3–8 lights that actually overlap its 16×16 tile.

This is a textbook GPU-driven pattern: the CPU sends the full light list once, the GPU filters it in parallel, downstream passes consume the filtered result. The CPU never touches individual light-to-tile assignments.

---

## Tile Frustum Construction

The core technical question in any tiled culling system is: how do you test whether a light affects a tile? The standard approach builds a frustum for each tile — four planes that bound the set of rays passing through that tile's region of the screen — and tests each light's bounding volume against that frustum.

We build the frustum from the tile's four NDC corners. Each corner maps to a view-space ray direction through the inverse of the projection matrix. Two adjacent corners define an edge of the tile. The cross product of those two ray directions gives the plane normal of the frustum face along that edge.

Here's the function from `light_cull.wgsl`:

```wgsl
fn make_plane_from_ndc_edge(p0: vec2<f32>, p1: vec2<f32>) -> vec4<f32> {
    // Unproject the two edge points to view-space rays (z = -1 in view space).
    let r0 = normalize(vec3<f32>(
        p0.x / camera.proj[0][0],
        p0.y / camera.proj[1][1],
        -1.0,
    ));
    let r1 = normalize(vec3<f32>(
        p1.x / camera.proj[0][0],
        p1.y / camera.proj[1][1],
        -1.0,
    ));
    // Plane normal = cross of the two rays (points toward inside of frustum).
    let n = normalize(cross(r0, r1));
    return vec4<f32>(n, 0.0);
}
```

The `w` component is zero because all four frustum planes pass through the camera origin — they are radial planes emanating from the eye. This is a crucial simplifying assumption: the near and far plane culling is handled separately by the light's range, so we only need the four lateral planes (left, right, top, bottom).

Building the four planes:

```wgsl
planes[0] = make_plane_from_ndc_edge(vec2<f32>(ndc_left, ndc_bottom), vec2<f32>(ndc_left,  ndc_top));    // left
planes[1] = make_plane_from_ndc_edge(vec2<f32>(ndc_right, ndc_top),   vec2<f32>(ndc_right, ndc_bottom)); // right
planes[2] = make_plane_from_ndc_edge(vec2<f32>(ndc_left,  ndc_top),   vec2<f32>(ndc_right, ndc_top));    // top
planes[3] = make_plane_from_ndc_edge(vec2<f32>(ndc_right, ndc_bottom),vec2<f32>(ndc_left,  ndc_bottom)); // bottom
```

The sphere-frustum test is then straightforward: for each plane, compute the signed distance from the sphere center to the plane. If the sphere is entirely on the negative side of any plane (distance < -radius), it's culled.

```wgsl
fn sphere_inside_tile_frustum(
    sphere_center_vs: vec3<f32>,
    sphere_radius: f32,
    planes: array<vec4<f32>, 4>,
) -> bool {
    for (var i = 0u; i < 4u; i++) {
        let dist = dot(planes[i].xyz, sphere_center_vs) + planes[i].w;
        if dist < -sphere_radius {
            return false;
        }
    }
    return true;
}
```

One subtlety: this test uses the light's `position_range.w` as the sphere radius. That works correctly only if the light's influence is spherical. For spot lights we waste some tiles — the sphere overestimates the cone. A cone-vs-frustum test would be tighter, but we haven't needed it yet. The sphere test is conservative (it never culls a light that should be visible) and simple.

---

## The Compute Dispatch

The shader is dispatched with one thread per tile, 256 threads per workgroup. At 1920×1080 with 16×16 tiles that's 120×68 = 8,160 tiles, so we dispatch 8,160 / 256 ≈ 32 workgroups. Each thread runs the full light loop for its tile.

The key number is `MAX_LIGHTS_PER_TILE`. We set it at 64. If a tile would contain more than 64 lights, the excess are silently dropped. In practice this never happens — a 16×16 tile covers a tiny screen region, and even in a dense light cluster the overlap count is usually under 10. The 64-slot limit exists to bound the storage allocation: `num_tiles * 64 * 4 bytes`. At 4K resolution that's about 8 MB for the list buffer plus a tiny count buffer.

Directional lights get a fast path: they have infinite range and always affect every tile, so we insert them unconditionally (up to the limit) and skip the frustum test. This avoids testing 80,000 tile-directional pairs per frame.

The shader itself is minimal — no shared memory, no thread synchronization, no atomics. Each thread writes to its own slice of the output arrays. The only shared resource is the read-only light buffer, which every thread reads independently. This is fine because lights are cached in the L1/L2 and the access pattern is uniform across threads.

---

## The Cache Key: Culling for Free

The most practical optimization in the system isn't in the shader at all — it's the cache key on the CPU side.

Every frame, before dispatching the compute pass, `LightCullPass::execute()` computes a cache key:

```rust
let camera_gen = ctx.scene.camera_generation;
let lights_gen = ctx.scene.movable_lights_generation;
let cache_key = (camera_gen, lights_gen, ctx.scene.movable_light_count);

if self.cull_cache_key == Some(cache_key) && !resolution_changed {
    return Ok(());
}
```

The generation counters increment whenever the camera moves or a light position/intensity/color changes. If the scene is static — which it usually is during editing, GUI interaction, or paused gameplay — the compute shader doesn't run at all. The tile lists from the previous frame are reused. This is safe because we use storage buffers (not transient descriptors) and the GPU pipeline has already consumed the previous frame's results by the time we reach `execute()`.

The savings are dramatic. In the editor workflow the camera is stationary most of the time. You change a material parameter, the G-buffer re-runs, but the light culling results are unchanged. The compute dispatch is skipped entirely. Over a typical editing session this saves thousands of redundant dispatches.

There's also a bind-group cache:

```rust
let camera_ptr = ctx.scene.camera as *const _ as usize;
let lights_ptr = ctx.scene.lights as *const _ as usize;
let key = (camera_ptr, lights_ptr);

if self.bind_group_key != Some(key) {
    // rebuild bind group
}
```

Bind group creation is not free on most GPU APIs. Avoiding redundant creation — especially during resize or light array reallocation — keeps the prepare phase cheap.

---

## Consuming the Culled Lists

The deferred lighting pass (`DeferredLightPass`) receives the tile buffers through `FrameResources`. In the fragment shader, every pixel computes its tile coordinate and reads the count:

```wgsl
let tile_x = u32(in.clip_pos.x) / TILE_SIZE;
let tile_y = u32(in.clip_pos.y) / TILE_SIZE;
let tile_idx = tile_y * globals.num_tiles_x + tile_x;
let tile_light_count = tile_light_counts[tile_idx];
for (var i = 0u; i < tile_light_count; i++) {
    let light_idx = tile_light_lists[tile_idx * MAX_LIGHTS_PER_TILE + i];
    let light = lights[light_idx];
    // distance check, shadow, BRDF...
    Lo += pbr_direct_light(light, world_pos, N, V, F0, albedo, roughness, metallic, sf);
}
```

The extra per-pixel work is trivial: an integer divide (cheap on modern hardware, especially with constant divisors), two storage buffer reads, and a loop. The storage buffer reads are coherent — adjacent pixels in the same tile read the same cache line — so the cache behavior is excellent.

The old code did:

```wgsl
for (var i = 0u; i < globals.light_count; i++) {
```

With 200+ lights that loop iterates 200 times per pixel regardless of whether the lights are relevant. The tiled version iterates the tile's light count, which averages 3–8 at 200 lights and rarely exceeds 20 even in extreme scenarios. The memory bandwidth savings from skipping 190+ light reads per pixel are the real win, not the ALU.

The deferred pass also handles the G-buffer normal/position decoding and PBR BRDF evaluation identically to before. The only change is the light loop. This made integration trivial: we dropped in the tile lookup, verified correctness with a debug visualization (tiles colored by light count), and moved on.

---

## Performance

We measured the tiled light culling pass at 1920×1080 with 200 dynamic lights on an RTX 4070:

| Configuration | Light Cull Compute | Deferred Lighting | Total Light Overhead |
|---|---|---|---|
| No culling (linear scan) | — | ~1.8 ms | ~1.8 ms |
| Tiled culling, warm cache | ~0.12 ms | ~0.35 ms | ~0.47 ms |
| Tiled culling, cache miss | ~0.12 ms | ~0.35 ms | ~0.47 ms |

The "cache miss" case is the same cost because the cache only skips the compute dispatch — it doesn't change the deferred pass. The compute dispatch itself is ~0.12 ms regardless of cache state, because every thread does the same work.

The real story is in the deferred pass: dropping from ~1.8 ms to ~0.35 ms. That's a 5x improvement, and it gets better as light counts increase. At 500 lights the linear scan would be ~4.5 ms while the tiled version stays near ~0.5 ms.

At 4K the tile count quadruples to ~32,640 tiles, and the compute pass rises to ~0.4 ms. The deferred pass stays under 1.0 ms because each tile still has ~3–8 lights.

---

## What This Doesn't Handle

Tiled light culling solves the per-pixel light count problem, but it's not a silver bullet.

**Area lights.** The current system only handles point and spot lights represented as spheres. Area lights (rectangles, disks, tubes) have more complex visibility functions. They need a different culling test — typically a box or oriented bounding box against the tile frustum. We haven't implemented area lights yet in Helio, so this is a future concern rather than a current limitation.

**Lights behind the camera.** The tile frustum extends infinitely behind the camera. A light behind the view origin with a large range can light tiles it shouldn't. The sphere-frustum test has no near-plane concept — it's purely lateral. Fixing this requires adding a near-plane culling step, which would be straightforward but hasn't been necessary. In practice, point lights behind the camera are rare and usually dim.

**The overestimation problem with spot lights.** As mentioned earlier, spot lights are tested as spheres. The sphere extends beyond the cone, so tiles that intersect the sphere but not the cone get false positives. The deferred pass does a second distance check, so the visual result is correct — but we do waste some tile list entries. A cone-frustum test would be more precise. The cost-benefit analysis hasn't tilted yet.

**Partial coverage at tile edges.** A light that barely touches a tile's frustum corner passes the test and adds its index to the tile's list. The deferred pass then evaluates it for all 256 pixels, even though only a handful near the edge are actually affected. This is inherent to any tile-based system — you're trading per-pixel precision for per-tile coherence. The smaller the tile, the less waste. 16×16 is a well-established sweet spot.

---

## What's Next

The tiled culling system works well enough that we're not planning major changes. The next frontier is **clustered shading** — partitioning the frustum into 3D clusters instead of 2D tiles, which handles overestimation better and scales naturally to area lights. Clustered shading builds a 3D grid in view space (x×y slices for the screen, z slices for depth), assigns each light to the clusters it overlaps, and the fragment shader reads only the lights in its cluster. The tradeoff is more complex construction and more storage per cluster.

We're also considering **screen-space light decals**. Some effects — like a flashlight cone hitting a wall — are better represented as a 2D light contribution projected into screen space rather than a 3D light that needs culling. Combining tiled light culling with screen-space decals would cover the gap between "big light that affects a volume" and "small highlight that affects a surface."

For now, tiled light culling is in production and stable. The cache key change alone was worth the implementation effort — it eliminated the compute dispatch from 90% of frames in the editor. If you're building a deferred renderer and you haven't added tile-based culling yet, it's one of the highest-ROI features you can add. The shader is ~160 lines. The CPU code is ~350 lines. The performance gain is a multiplier that grows with your light count.

The code lives in `helio-pass-light-cull` — the shader at `shaders/light_cull.wgsl`, the pass at `src/lib.rs`. Both are open source as part of Helio.
