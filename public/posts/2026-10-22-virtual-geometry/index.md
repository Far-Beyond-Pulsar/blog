---
title: "Not Enough Triangles: Helio's Virtual Geometry in Action"
date: "2026-10-22"
author: ["tristanpoland"]
tags: ["rust", "helio", "scenedb", "rendering", "wgsl", "architecture", "pulsar"]
description: "What virtual geometry is, where it helps and where it does not, how Helio selects geometry per cluster on the GPU and rasterizes it in three tiers, and what the first measurements on a 777 million triangle scene looked like."
thumbnail: /post_thumb/vgeometry.png
---

![The museum scene, rendered with Helio's virtual geometry](./assets/hero-temple-fog.png)

## Introduction: Counting Triangles Nobody Can See

The museum scene we use to stress Helio's virtual geometry holds 777 million source triangles. Seventy-two statues account for 408 million of them and 162 trees for 368 million. The building around them is 1.7 million. A frame has a few million pixels.

A conventional renderer pays for every triangle that survives frustum culling, whether or not it can cover a pixel. Artists answer with hand-made level-of-detail meshes, impostors, and triangle budgets. That works until the budget changes, the asset changes, or someone drops a 28 million triangle scan into the level because they can.

Virtual geometry flips the cost model. Each mesh is cut into small clusters and organized so the GPU can pick, per cluster and per frame, the coarsest version whose error stays under a pixel. Triangle count in the scene stops mattering much. Triangles per pixel does.

This post is written for two readers. If you are new to the idea, the first three sections cover what virtual geometry is, where it came from, and when you should and should not reach for it. If you want the machinery, the rest walks through Helio's implementation from the offline asset format to the compute shaders that decide what gets drawn, with debug views of each stage. The last sections report what we measured when the first full scene ran, including the parts that went badly.

The code discussed comes from the `helio-vg-*` crates and the `helio-pass-vg-*` passes. All numbers come from one machine (an RTX 4090 on Vulkan through wgpu 30), one scene, and a handful of camera positions. They show where the time went on that machine. They do not describe a general performance profile.

## 1. The Problem

A pixel is the unit of work a display can show. A triangle smaller than a pixel cannot be seen as a triangle. It can only add noise, because its colour lands in one pixel or none, and which one changes as the camera moves.

Scanned and sculpted assets routinely carry millions of triangles, most of them far smaller than a pixel from any reasonable viewing distance. Rendering all of them costs vertex processing, setup, and rasterization, and the image gets worse for it. Shimmer, aliasing, and moire come from geometry that is finer than the sampling rate.

So the useful amount of geometry for an object depends on how many pixels it covers. Close to the camera a statue wants all its detail. Across a courtyard it wants a thousandth of it. Something has to choose, every frame, for every object, and the choice has to avoid cracks between pieces and visible popping as the camera moves.

## 2. Where the Idea Comes From

Discrete level of detail is the oldest answer. An artist or a tool produces a chain of meshes, each with fewer triangles, and the engine swaps them by distance. It is simple and fast and runs everywhere. It also costs authoring time, multiplies memory by the length of the chain, pops when the swap happens unless it is blended, and chooses per object, so a large mesh that spans a wide range of distances gets one level for all of it.

Impostors and billboards replace distant objects with images. They suit trees and crowds in the far field and lose parallax the moment the camera moves enough to notice.

Hardware tessellation adds triangles where a patch needs them. It suits displaced surfaces and terrain. It does nothing for a mesh that already has too many triangles, and modern APIs treat it as a niche feature.

Meshlet pipelines cut a mesh into small clusters, cull them on the GPU, and draw what survives, usually through mesh shaders. They remove most of the per-triangle cost of rejected geometry. They do not choose a level of detail by themselves, and they need hardware support that some graphics layers, wgpu among them, do not expose.

Cluster hierarchies combine the last idea with a simplification graph. Every cluster has coarser versions built from groups of its neighbours, and the GPU picks a consistent cut through that graph for each view. Unreal Engine 5's Nanite made the approach well known, and the talk Brian Karis gave at SIGGRAPH 2021 is the best public description of it. Helio's design follows the same family of ideas: a cluster DAG, a visibility buffer, a software rasterizer for tiny triangles, and streaming of cluster pages. The implementation details below are ours.

Voxel and point-cloud renderers are a different branch. They give up triangles entirely, and they fit a narrower set of assets and pipelines.

## 3. When to Use It, and When Not To

The approach pays off when geometry is dense and static. Photogrammetry scans, sculpts exported straight from a sculpting tool, kitbashed environments with thousands of unique detailed pieces, and scenes with many instances of one heavy asset all fit. Artists skip LOD authoring. The triangle budget follows the screen, so a level can use assets that would never have fit a hand-tuned budget. Streaming means an asset does not need to be fully resident to render.

Several kinds of content do not fit, at least today:

- Skinned and vertex-animated meshes. The hierarchy is built offline from rigid geometry. Helio's virtual geometry path accepts static meshes only.
- Alpha-blended transparency. A visibility buffer stores one surface per pixel. Alpha-tested materials can work, and Helio supports them, but blended ones cannot.
- Thin, disconnected geometry. Leaf cards, needles, chain fences, and hair do not simplify the way closed surfaces do. We ran into this directly and section 19 describes it.
- Small, low-poly, or stylised scenes. The system has a fixed cost per frame for traversal, culling, resolve, and shading. A scene of a few thousand triangles per object pays that cost for nothing. We have not measured the crossover point.
- Weak or constrained hardware. Helio's passes need at least 20 storage buffers per shader stage, indirect draws with a first-instance offset, and compute. WebGPU default limits fall short of that.

The costs are real even when the content fits. Every mesh needs an offline build that produces a cache file. In our scene those caches total about 3.9 GB, and the 28 million triangle Lucy scan builds in about a minute and peaks near 3.8 GB of memory. Materials evaluate per pixel after visibility, which favours few materials and costs more with many. Shadows need their own answer, because a shadow map rendered from the light's view needs the same cluster selection for that view. Debugging a GPU-driven system without views into it is slow. That last point is why Helio ships seventeen debug views.

## 4. The Pipeline at a Glance

Per frame, the chain of passes runs in this order after the classic G-buffer pass has drawn everything that is not virtual geometry:

```
stream update          page uploads and residency table
instance BVH           build or refit the global instance tree
cull (phase 0)         traverse, test, bin clusters visible last frame
raster (early)         hardware and software tiers, first phase
Hi-Z (late)            pyramid from the phase 0 depth
cull (phase 1)         retest what phase 0 deferred
raster (late)          second phase raster
dense tiles            optional Tier 3 re-resolve of overlapped tiles
resolve + shade        merge, barycentrics, material bins, G-buffer, depth
```

Deferred lighting, SSAO, reflections, and the temporal upscaler run afterwards on the same G-buffer. They never learn that a pixel came from virtual geometry.

## 5. Clusters and the Error Rule

A mesh enters the system as an indexed triangle list with a material per triangle. The builder cuts it into clusters of at most 128 triangles and 128 vertices, keeping each cluster inside one material section. Clusters are grouped (four to eight at fine levels, up to 32 near the top), and each group is simplified to roughly half its triangles. The simplified group is split back into new clusters, and the process repeats until a handful remain.

The result is a directed acyclic graph. Every cluster has a coarse parent version covering the same surface, and a cluster can be replaced by its parents or its children without leaving a hole, as long as the group boundaries stay fixed. The simplifier locks vertices on group boundaries for that reason. Two neighbouring groups can then pick different levels of detail and still meet at identical vertices.

Each cluster carries two numbers that matter at runtime: its own error and the error of the group that replaced it. Both are object-space distances.

```rust
#[repr(C)]
pub struct GpuCluster {
    pub sphere: [f32; 4],        // culling bounds and self-error sphere
    pub parent_sphere: [f32; 4], // sphere of the group that consumed it
    pub cone: u32,               // backface cone, snorm8 axis and cutoff
    pub self_error: f32,
    pub parent_error: f32,
    pub counts_material: u32,    // triangles, vertices, material slot
    pub vertex_offset: u32,
    pub index_offset: u32,
    pub group_id: u32,
    pub flags: u32,
}
```

The record is 64 bytes. The cut rule uses nothing else. A cluster is drawn when its own error projects to at most tau pixels and its parent's error projects to more than tau. Each cluster decides alone, with no talk between neighbours, and the rule still produces exactly one drawn cluster on every path from a leaf to the root. That property needs parent errors to be at least child errors and parent spheres to contain child spheres. The builder enforces both, and a CPU simulation checks it against more than a thousand combinations of distance, threshold, scale, and page residency.

The projection is the usual pinhole formula. With vertical projection scale $P_{11}$, viewport height $H$, and the distance $d$ from the camera to the nearest point of the cluster sphere:

$$
e_{px}=e\cdot\frac{P_{11}}{2}\cdot\frac{H}{d}
$$

The shader clamps $d$ to the near plane and measures to the sphere's near side. A containing sphere then never projects smaller than a contained one, which keeps the cut free of holes.

```wgsl
fn proj_err(err: f32, c: vec3<f32>, r: f32) -> f32 {
    if err >= INF_ERR { return HUGE_PX; }
    let d = max(view_depth_of(c) - r, cameras[0].position_near.w);
    return err * cameras[0].proj[1][1] * 0.5 * f32(params.screen_height) / d;
}
```

### 5.1 Measuring error instead of estimating it

The first version of the builder derived error from quadric costs and added the child errors up the hierarchy. On real scans it overshot badly. At 96 metres the Thai statue selected 166,876 triangles, where the coarsest level of the same asset has 862.

The current builder stores reference points on the original surface inside each cluster, and a group's error is the measured distance from those points to the simplified surface, with a margin of 1.4. Parent error is the maximum of the children and the group's own error. On a 1.3 million triangle noisy sphere, the stored error lands between 1.2 and 1.55 times the true maximum deviation per level, measured independently in both directions. Selection for a sphere 18 pixels tall dropped from 4,714 triangles to 174.

Real scans did not improve as much. Lucy (28 million triangles) selects 3,122 triangles at 18 pixels tall, 20,452 at 100 pixels, and 138,612 at 1000 pixels. A whole-mesh simplifier reaches lower deviation at equal triangle count by a factor of four to ten. A thin horn removed early in a cluster hierarchy leaves a large error that every ancestor inherits through the maximum. Vertex repositioning would help and the builder does not do it yet.

## 6. Pages, Quantization, and Residency

An asset on disk is a `.vgeo` file. Position data is quantized onto an 18-bit lattice shared across the whole asset, so shared vertices decode to identical values no matter which cluster or page supplies them. A per-cluster grid would open cracks. Attributes live in a separate stream, because only the shading pass reads them and the rasterizers should not pay that bandwidth.

Clusters are packed into 128 KiB pages, coarsest levels first. A small hierarchy over the groups (four children per node, each with a bounding sphere and the largest parent error below it) stays resident for every asset. Root pages stay resident too, so the cut can always fall back to something. If a cluster needs a child that is not in memory, the cull draws the parent and appends a request to a deduplicated GPU list. A readback a few frames later tells the CPU scheduler what to load.

The scheduler orders requests by count and recency, evicts the least recently used page after a grace period, and never evicts a root page. One rule came out of integration testing. A page may only be resident when the pages holding its parent clusters are resident, otherwise the root clusters cannot be drawn and the cut breaks. The `.vgeo` carries a dependency table for that, and the scheduler loads dependencies first.

Memory has two sides. GPU pages live in one pool buffer that grows toward a budget (512 MiB by default). CPU bytes pass through SceneDB's `Residency` cache, which puts them in the same accounting as every other streamed asset. Cache files are opened by path and read a page at a time. For a while the example read whole files into memory. With 3.9 GB of cache on disk, that was part of why the process grew past 10 GB.

## 7. Scene Data Stays in SceneDB

Helio's scene model has one owner, the SceneDB world. Passes read GPU buffers by key and never scan the world on the CPU. Virtual geometry follows the same rule and adds no second scene store.

A mesh instance becomes virtual geometry when its `VirtualGeometryComponent` is enabled and its asset is ready. The component holds the knobs an artist would want: an enable flag, a tier lock, an error scale, a force-root flag, and a shadow flag. A mesh without the component uses defaults.

A scene derivation joins static mesh rows, the optional component rows, and asset readiness into a compact `vg_instances` buffer on the GPU. Each row is 16 bytes: asset slot, flags, error scale, and the row in the scene join's object buffer. It recomputes only when an input changes. The same derivation publishes a `lod_suppressed` buffer. Authored LOD and virtual geometry are alternatives. An instance drawn by virtual geometry ignores its `LODComponent`, and the authored LOD selection skips it. If the asset is not ready yet, the instance stays classic and authored LOD keeps working, so no frame has neither.

The classic path skips virtual geometry rows through a suppression flag on the object batch, and shadows still use classic geometry. That second part is a stand-in, and the limits section comes back to it.

## 8. A Global Instance BVH

Culling per instance does not scale to a hundred thousand small objects, and a single statue with 28 million triangles is the opposite case. Helio uses one traversal for both.

Instances go into a binary BVH built on the GPU with Morton codes and a Karras tree. A stable radix sort orders the instances, and a refit pass handles transform-only changes without rebuilding. Up to 64 tiny neighbours can merge into one batch leaf, so a field of bolts does not cost a node each. The traversal then continues straight from an instance leaf into that asset's cluster hierarchy, using one persistent work queue of instance and node pairs. There is no per-instance dispatch and no per-instance list of clusters.

## 9. The Cull Pass

Every job in the queue tests only its own bound. That makes it safe to defer work, and the pass uses it: traversal runs in a few rounds, and a workgroup that fills its local stack spills to the next round.

Each job runs a frustum test, a Hi-Z occlusion test, the error rule, and a cone test for clusters whose instance has an angle-preserving transform.

Occlusion runs in two phases. The first phase draws what was visible last frame and tests the rest against last frame's Hi-Z. A new Hi-Z is built from that depth, and the second phase retests the deferred work against it. A wrong answer in phase one costs nothing, since phase two corrects it.

Surviving clusters land in eight bins: four hardware bins by triangle count (32, 64, 96, 128), one software bin for clusters whose average projected edge is two pixels or less, one for dense candidates, and two for alpha-masked clusters. The bins double as indirect arguments for the passes after. Capacity grows lazily from a stats readback. A bin that overflows drops clusters for a frame and counts them. The overflow counter read zero in the museum runs below.

:::gallery
![Final image at the overview pose](./assets/dbg-normal.png)
![Culling survival: which test each cluster passed](./assets/dbg-culling-survival.png)
![Error against tau: how close each cluster is to refining](./assets/dbg-error-vs-tau.png)
:::

The counters behind the first frame above are recorded for every capture. At the overview pose the cull tested 221,580 clusters and emitted 82,159. It rejected 53,414 on error, 2,618 on the frustum, 319 on the cone test, and 2 on occlusion. Occlusion barely fires in an open courtyard, and a view down a colonnade would show more.

## 10. The Visibility Buffer

Everything draws into the same thing: a buffer of ids. Triangles do not carry colour or material through raster.

```rust
// visible cluster index in the high 25 bits, triangle in the low 7
pub fn vis_pack(visible_cluster: u32, tri: u32) -> u32 {
    (visible_cluster << 7) | (tri & 127)
}

// software tiers race on this: reversed-Z depth bits above the id
pub fn raster_key(depth: f32, id: u32) -> u64 {
    ((depth.to_bits() as u64) << 32) | id as u64
}
```

The depth buffer is reversed, so a larger float is nearer and an unsigned maximum picks the winner. A resolve pass later recomputes exact barycentrics per pixel and writes the unified payload, an id word plus two 16-bit barycentrics. Putting barycentrics in the atomic would have cost the depth, so they wait for the resolve.

:::compare
![Final shading](./assets/dbg-normal.png)
![Triangle ids](./assets/dbg-triangle-id.png)
:::

The comparison above is the same frame twice. On the right every colour is a hash of the triangle id. The tall Poly Haven trees dissolve into confetti, and so do the statues, because their triangles are small. The architecture and the cone-shaped cypress trees keep flat colour, because those are classic geometry that never enters the buffer.

## 11. Tier 1: Hardware Raster

wgpu has no mesh shaders, so Tier 1 pulls vertices by hand. Four indirect draws, one per triangle-count bin, each with the first instance set to the visible cluster index. The vertex shader derives the triangle from the vertex index and decodes quantized positions from the page pool. Triangles past the cluster's count collapse to nothing. The fragment shader writes the id into an `R32Uint` target against a shared depth buffer.

No material runs here. A triangle that loses the depth test costs a few instructions.

## 12. Tier 2: Micro-polygon Raster

Triangles smaller than a couple of pixels waste a hardware rasterizer, which shades in quads and sets up per primitive. Tier 2 is a compute rasterizer. One workgroup handles one cluster, transforms its vertices into shared memory, and gives each thread one triangle. It tests against the hardware depth first, then races on the 64-bit key with an atomic maximum.

That needs `SHADER_INT64` and `SHADER_INT64_ATOMIC_MIN_MAX`, which Helio now requests as optional device features. Without them the same bins go through a tiled kernel. It bins triangles per 16 by 16 tile and resolves each tile in workgroup memory with no global atomics, and it writes the same bytes as the atomic kernel. Tests compare the two for equality.

Triangles up to 64 pixels use edge functions snapped to 1/256 pixel, so shared edges are exact. Larger ones use float edge functions. Triangles crossing the near plane are skipped and counted, not clipped.

:::gallery
![Projected triangle size: red is sub-pixel, blue is large](./assets/dbg-triangle-size.png)
![Raster tier: hardware, micro-polygon, dense](./assets/dbg-raster-tier.png)
![Software overdraw per tile](./assets/dbg-sw-overdraw.png)
:::

## 13. Tier 3: Dense Tiles

A tile where many triangles stack on each other is slow for a software rasterizer, because contention on the atomic grows with overlap. Forests are the usual case, and our trees are real needle geometry.

The software pass counts triangles and depth-passing hits per tile, and a classify step marks tiles as dense with some hysteresis. The cull routes software-class clusters that overlap last frame's dense tiles into a separate bin. Tier 3 then re-resolves those tiles with one of two backends.

The first is a depth peel. One workgroup per tile builds a depth histogram of the tile's clusters, then peels front to back in slabs, stopping when every pixel is final.

The second casts primary rays. Helio builds proxy meshes from the cluster hierarchy, a consistent cut at an error level chosen for the instance's distance, expands them to plain triangles, and builds acceleration structures through the same cache the hybrid lighting pass uses. A kernel marks the instances that touch dense tiles, an asynchronous readback hands the list to the CPU, and a ray query pass fills the same key buffers the peel would. On a crowd of 40 instanced spheres the two backends produce identical pixels, and the top-level structure rebuilds once and then gets reused.

The ray tracing path has limits worth stating. Hardware rays cannot evaluate a per-pixel cluster cut, so each instance traces through one proxy level. A new dense instance can leave a hole for one to three frames while the readback catches up. And the path is not alpha-aware, so any masked cluster in a dense tile switches it off for twelve frames.

:::gallery
![Dense tile overlap in the forest](./assets/dbg-dense-overlap.png)
![Dense tile mask](./assets/dbg-dense-mask.png)
:::

In a capture of the forest with Tier 3 on, the stats told a plain story. The dense pass took 93.4 ms of a 98.6 ms frame, against 4.3 ms with Tier 3 off. Ray query hardware was present, the tier counted 193 dense tiles, and across 450 frames the ray-traced backend ran zero times. All 450 went to the depth peel. The selector's conditions for switching, among them resident proxies for every dense instance and no masked cluster in a dense tile, did not hold in a scene full of masked leaves.

:::gallery
![Forest with Tier 3 off](./assets/tier3-off.png)
![Forest with the depth peel](./assets/tier3-on-peel.png)
![Forest with ray tracing requested](./assets/tier3-on-rt.png)
![Dense overlap with Tier 3 off](./assets/tier3-off-dense-overlap.png)
![Dense overlap with the depth peel](./assets/tier3-on-peel-dense-overlap.png)
![Dense overlap with ray tracing requested](./assets/tier3-on-rt-dense-overlap.png)
:::

## 14. Resolve and Shading

One compute pass merges the hardware id buffer with the software and dense keys, nearest wins, ties go to hardware. It tests the winner against the classic scene depth so virtual geometry and classic meshes composite in either order. Barycentrics come from a homogeneous clip-space solve, which is the pixel ray without clipping, and the worst barycentric error in the GPU test was about 1.5e-5.

Pixels are then binned by material class with a prefix sum, and one indirect dispatch per bin shades them. The shading shader is the classic G-buffer evaluator, spliced out of `gbuffer.wgsl` at build time, so template overrides like clear coat and subsurface behave the same way in both paths. Output goes to the same G-buffer, and a small final pass writes depth. SSAO, deferred lighting, and the temporal upscaler see nothing different.

Texture derivatives come from the barycentrics of the neighbouring pixels, since compute shaders have no implicit derivatives.

:::gallery
![Barycentrics decoded from the visibility buffer](./assets/dbg-barycentrics.png)
![Material bin per pixel](./assets/dbg-material-bin.png)
![Albedo only](./assets/dbg-albedo.png)
![Lighting only](./assets/dbg-lighting-only.png)
:::

## 15. Alpha-masked Materials

Leaves are alpha cards, and 213 million of the tree triangles in the museum scene are cards. A visibility buffer cannot discard per fragment later, so alpha testing happens in raster.

Masked clusters are identified at cull time from the material row and go to their own bins. The hardware masked pipeline samples the alpha texture with interpolated UVs in the fragment shader and discards. The software masked kernel evaluates alpha per covered pixel before the atomic race, using a mip chosen from the triangle's UV density. The dense peel gets a second pipeline for masked work. Two-sided materials skip the cone test and the backface cull.

Opaque clusters pay nothing for any of this. Their pipelines get no new bindings and no branches. With no material table bound, the cull does no material loads at all.

Coverage over distance matters for thin foliage. On the actual leaf textures coverage stays at 0.99 or better through mip 5 and drops to between 0.88 and 0.96 at mip 6. A synthetic thin-stroke mask loses more than half its coverage by mip 4, so hair or fence textures would thin with distance the way they do in any mip-based alpha test.

![Tree canopy close-up with alpha-masked leaves](./assets/trees-canopy-closeup.png)

## 16. Debug Views

Seventeen views register through the render graph's debug view list and appear in the editor viewport menu under Virtual Geometry. They cost nothing when off, since the debug pass is only recorded while one is selected.

- Triangle id and cluster id, hashed to colours.
- LOD level, detail against the asset extent, and projected triangle size in pixels.
- Raster tier, software overdraw, dense tile overlap, and the dense tile mask.
- Page residency, culling survival, and error against tau.
- Instance id, barycentrics, the normal decoded from the id, the material bin, and a mask of which pixels virtual geometry shaded.

Two of them only approximate what the name promises. The format has no level field, so the LOD view estimates depth from the error and the cluster radius. The detail view compares against the asset's lattice extent, since the root error of a cluster is infinite on the GPU.

:::gallery
![Cluster ids](./assets/dbg-cluster-id.png)
![LOD level](./assets/dbg-lod-level.png)
![Detail against the asset extent](./assets/dbg-detail-vs-root.png)
![Page residency: refined, leaf, fallback parent](./assets/dbg-page-residency.png)
![Instance ids](./assets/dbg-instance-id.png)
![Classic against virtual geometry](./assets/dbg-classic-vs-vg-mask.png)
:::

The stats line in the demo window reads from the cull pass's asynchronous counter readback, so showing it does not stall the GPU.

## 17. Detail by Distance

The same statue seen from four distances, each as final shading, triangle ids, and cluster ids, shows the cut working. Close up, the triangles are small and numerous. At 150 metres the whole statue fits in a few clusters and the triangle view is a handful of large colour patches.

The frame-wide selected triangle counts from the stats files (they include everything in view, not just the statue) were 634,671 at 3 m, 1,752,314 at 12 m, 5,686,120 at 48 m, and 2,023,405 at 150 m. The 48 m shot looks across the courtyard and sees more statues and trees, which is why it sits highest. GPU time for the frame was 2.1, 2.5, 6.3, and 2.4 ms.

:::gallery
![Lucy at 3 m](./assets/lucy-3m-normal.png)
![Lucy at 3 m, triangles](./assets/lucy-3m-triangles.png)
![Lucy at 3 m, clusters](./assets/lucy-3m-clusters.png)
![Lucy at 12 m](./assets/lucy-12m-normal.png)
![Lucy at 12 m, triangles](./assets/lucy-12m-triangles.png)
![Lucy at 12 m, clusters](./assets/lucy-12m-clusters.png)
![Lucy at 48 m](./assets/lucy-48m-normal.png)
![Lucy at 48 m, triangles](./assets/lucy-48m-triangles.png)
![Lucy at 48 m, clusters](./assets/lucy-48m-clusters.png)
![Lucy at 150 m](./assets/lucy-150m-normal.png)
![Lucy at 150 m, triangles](./assets/lucy-150m-triangles.png)
![Lucy at 150 m, clusters](./assets/lucy-150m-clusters.png)
:::

The error tolerance is a quality knob. The demo exposes tau live. The images below hold the camera still and raise tau from half a pixel to 64 pixels. Frame-wide selected triangles fall from 2,070,466 at 0.5 pixels to 1,555,120 at 1, 808,735 at 4, 341,000 at 16, and 248,181 at 64. GPU time for the frame goes 2.4, 2.5, 2.3, 1.8, and 1.8 ms, so on this view the pass cost moves much less than the triangle count. At 64 pixels the Lucy statue has facets you can see from across the courtyard, while the nearer dragon keeps most of its detail, because its error projects to more pixels.

:::gallery
![tau 0.5 pixels](./assets/tau-0p5.png)
![tau 1 pixel](./assets/tau-1.png)
![tau 4 pixels](./assets/tau-4.png)
![tau 16 pixels](./assets/tau-16.png)
![tau 64 pixels](./assets/tau-64.png)
:::

The same five settings as triangle id views show where the budget goes.

:::gallery
![tau 0.5 pixels, triangles](./assets/tau-0p5-triangles.png)
![tau 1 pixel, triangles](./assets/tau-1-triangles.png)
![tau 4 pixels, triangles](./assets/tau-4-triangles.png)
![tau 16 pixels, triangles](./assets/tau-16-triangles.png)
![tau 64 pixels, triangles](./assets/tau-64-triangles.png)
:::

## 18. The Museum Scene

The scene has the architecture kit, 72 statue instances from the Stanford scanning repository (Lucy at 28 million triangles, the Thai statue at 10 million, two dragons, the Buddha, and a manuscript), and 162 trees from Poly Haven, which publishes them under CC0. The pine package holds 17 million triangles across three variants. Every asset cooks once into a `.vgeo` cache, keyed by content hash, and later runs skip the work. A 1 million triangle mesh builds in about two seconds. Lucy takes about a minute.

### 18.1 Scripted shots

Every image in this post came out of the demo's capture mode, which follows the same approach as Helio's other offscreen examples. A shot list in `shots.json` describes each camera (a fixed pose or a keyframed path), the debug view, the error tolerance, the lens, the fog, and the sun. The renderer steps at a fixed timestep, waits for every virtual geometry asset to become ready and for the page pool to settle, renders offscreen, and writes a PNG. A stats file next to each image holds the cull counters, the page pool numbers, and the per-pass GPU times averaged over the last 30 frames.

Debug shots turn the lens and fog off so the data stays readable. The beauty shots use the full stack: volumetric fog with light shafts, post-process volumes, and the camera lens component set up for a shallow depth of field. The colonnade shot below uses an 85 mm lens at f/2 focused 9.3 m away, with fog density 0.02 and shafts enabled. The lens pass cost 0.74 ms and the fog pass 0.72 ms in that frame, which took 5.2 ms in total.

![Sunlight through the colonnade, focus on the urn](./assets/hero-colonnade-sunshafts.png)

The subject stays sharp and everything in front of and behind it dissolves into bokeh. That is a composition choice, and it is also a nice test of the pipeline. Depth of field is reconstructed from the G-buffer depth, so virtual geometry has to write correct depth for the lens to blur it correctly.

![Portrait of the Lucy statue, shallow focus on the face](./assets/hero-lucy-portrait.png)

:::gallery
![Courtyard statues](./assets/hero-courtyard-statues.png)
![The Thai statue on its pedestal](./assets/hero-thai-pedestal.png)
![Interior hall with fog and soft shafts](./assets/hero-interior-hall-dust.png)
![Pine foreground sharp, forest in bokeh](./assets/hero-pine-bokeh.png)
![Forest at dusk](./assets/hero-forest-dusk.png)
:::

A rack focus pair uses the same framing twice, with the focus pulled from a near dragon to a far one.

:::compare
![Focus on the near dragon](./assets/hero-dragon-court-rack-focus-a.png)
![Focus on the far dragon](./assets/hero-dragon-court-rack-focus-b.png)
:::

:::gallery
![Lucy, close up](./assets/statue-lucy-closeup.png)
![The Thai statue, close up](./assets/statue-thai-closeup.png)
:::

The forest at dusk is the heaviest fog in the set, and it is on the edge of too much. The haze flattens the colour and the foreground trees read as silhouettes. It works as a mood shot and would not suit a gameplay camera.

### 18.2 Numbers from the live demo

Before the capture mode existed, the live demo with everything enabled ran the whole scene at 190 to 230 milliseconds a frame. Profiling showed one pass:

- Automatic mode: 190 to 230 ms, with the dense pass taking up to 229 ms.
- Forced depth-peel fallback: about 203 ms, dense pass 199 ms.
- Hardware raster only: about 7 ms, raster 3.2 to 3.7 ms.
- Automatic mode with Tier 3 switched off: about 3.1 ms of GPU time, cull 0.6 and 0.5, raster 0.6, G-buffer 0.25.

The per-pass numbers come from the render graph's GPU timestamps. The windowed frame time in the last case is about 6 ms, which matches the swap chain's vsync interval, so GPU time is the number to read. The selected triangle count in those views sat between 24 and 45 million out of 777 million in the scene, with a dense cluster count of zero.

The per-pass timings point at one pass. In the dense overlap view the tree canopies saturate, and the stats line from a Tier 3 run reported more than 200,000 dense clusters. Which backend handled the museum's dense tiles was not recorded in these measurements.

A separate crowd test of 40 instanced spheres showed two defects in the same tier. The depth peel overflowed its per-tile cluster lists by about 16,700 entries a frame. The dense mask also alternated between four tiles and zero from frame to frame. A likely reason is a feedback loop, since clusters routed to the dense bin stop feeding the counters that keep their tiles dense. The blocky holes visible in earlier screenshots were absent from a capture with Tier 3 off, and we have not traced them to a specific bug.

Tier 3 is now an opt-in setting and defaults to off. With it off, the capture at the overview pose reads 3.7 ms of GPU time for 5.87 million selected triangles out of 777 million in the scene. The cull passes took 1.2 and 0.2 ms, the early raster 0.9 ms, and shading 0.13 ms.

## 19. What Went Wrong Besides That

The pool filled up. After the scene loaded, quality would drop and pages would reload. Pool statistics at fourteen seconds read 4096 of 4096 pages resident, 3671 of them root pages, and 571 evictions. Reading the `.vgeo` headers showed seven assets whose root page count equals their total page count. For those the builder never produced a coarse level. The three biggest were the opaque pine variants, 6.84, 5.92, and 4.14 million triangles.

Measuring the pine twig meshes found the cause. They are 406,000, 246,000, and 352,000 connected components, with a median of 11 triangles per component and 44 percent of edges open. The island tree branches look similar. Open edges and UV seams were locked, so on a synthetic canopy 98.8 percent of vertices were pinned, and the first level removed only 2.6 percent of the triangles. The rule that abandons a level removing less than twenty percent then threw the level away, and the root equalled the leaves. For one pine part of 6.95 million triangles the reference cut selected 6.83 million at 20 metres and 6.82 million at 100. That asset never got cheaper. Together those roots pinned 459 MiB of the 512 MiB pool and left every other asset fighting over about 425 slots.

The fix treats small connected components, up to 1,536 triangles, as floating pieces. A floating piece inside one group simplifies with no locks. Edge collapse prunes tiny islands, and a proximity merge joins nearby disconnected pieces when collapse stalls. Material sections are never merged. A level is now abandoned only when it keeps more than 97 percent of its triangles, and the number of root pages is capped at 16 (2 MiB) by construction. If the top level cannot fit, the build fails and the loader can refuse the asset.

Pinned root pages across the cache dropped from 3,671 to 56. The reference cut for the pine twigs went from everything at every distance to between 396,000 and 480,000 triangles at 20 m and between 12,000 and 40,000 at 100 m. Island branches, island leaves, and the small tree leaves reach at most 30,000 at 100 m. The statues were unchanged within noise.

The fix comes with a cost. For groups made mostly of floating pieces the error is no longer a Hausdorff distance. It is the larger of the child errors, twice the square root of the mean output triangle area, and a term from the group's bounding sphere. Hausdorff distance overreports for a canopy, because a vanished card leaves a hole its own size while its neighbours are far away, and that kept every ancestor at fine detail. The stored error for those groups can sit below the true deviation. Alpha-masked cards also lose coverage when merged.

The pool is still crowded. The captures above ran with 4,096 of 4,096 pages resident (512 MiB), 56 of them roots, and between 19,500 and 30,000 evictions accumulated across the run, with 282 feedback list overflows. Roots no longer pin the pool, but the working set of a courtyard at one pixel of tolerance is larger than the budget, so pages churn. A bigger budget, a smarter eviction order, or both would help. We have not tuned either.

Texture sampling also took a detour. After the first full run the marble looked smeared in long single-axis streaks. The UV debug view showed clean, evenly tiled UVs, so the geometry was fine. The scene never set a material sampler, and Helio's shared default is clamp-to-edge with nearest filtering. UVs above one clamp to the edge texel and extrude it across the face, which matches the pattern. The demo now installs a repeat, trilinear, 16x anisotropic sampler. We have not yet seen the result on screen.

## 20. How This Compares

We have not run a head-to-head benchmark against another engine, so this post makes no claim about being faster than anyone. What follows are design choices that differ, and where each one costs something.

Portability. Helio runs on wgpu, so the same passes target Vulkan, DX12, and Metal. wgpu exposes no mesh shaders, which is why Tier 1 pulls vertices by hand. The 64-bit atomic kernel is an optional feature with a tiled fallback that writes identical output. The price is a higher binding count than a mesh shader path would need, and a floor on device limits.

One traversal for any instance count. The global instance BVH and persistent job queue mean a single giant asset and a hundred thousand small ones go through the same code, with no per-instance dispatch.

Scene data through SceneDB. Instance rows, component overrides, and asset readiness are GPU-resident rows joined on the GPU. Nothing scans the world on the CPU in the render path, and no second scene store exists. Editing a component takes effect through the same writes as everything else.

The same shading as the classic path. The resolve pass splices the classic G-buffer evaluator, so materials, templates, and downstream passes need no virtual geometry variant.

A separate tier for dense overlap, with an optional ray-traced backend. This one is built and tested and currently off, for the cost reasons in sections 13 and 18.

Production systems have years of work in areas where Helio is behind: cluster-aware shadows, deformation and skinning, tuned hierarchies for thin geometry, and tooling around cooking and streaming. The limits below are the plainest list of the gaps.

## 21. Limits and What Comes Next

Shadows use classic geometry. In the editor path a virtual geometry mesh keeps its classic copy for the shadow pass, so shadow cost still scales with source triangles. The museum example gives each virtual geometry part a one-triangle placeholder row, so those parts cast no shadows at all. A cluster-aware shadow pass would reuse the same cull with light views.

Everything above ran on one GPU, one driver, and one backend. The expanded-binding shader variants validate but have never run. The BVH build uses relaxed atomics for bottom-up bounds and has only been tried on the 4090.

Pixel-error selection is conservative on smooth statues and loose on thin geometry. At 100 pixels the real scans select between 11,000 and 23,000 triangles. A whole-mesh simplifier reaches four to ten times lower deviation at equal triangle count, so a tighter hierarchy could pick fewer. The needle problem in section 19 is fixed for the pine and island meshes, with the error caveat described there. The pine twigs still select roughly 400,000 to 480,000 triangles each at 20 metres, because that geometry is dense at that range.

Only static, rigid meshes go through this path. Skinned meshes, voxels, and foliage placement stay classic. Blended materials can never be virtual geometry. Double-sided masked materials work, and a single-sided masked material discards its back faces in the fragment shader.

Dense tiles are the open bug. With Tier 3 on, the dense pass costs 93 to 229 ms a frame on the museum, against about 4 ms with it off, and the ray-traced backend never took over in the forest capture despite hardware support (0 of 450 frames). Ray-traced dense tiles are built, tested, and wired into the graph, and they are off with the rest of Tier 3. Masked leaf clusters inside a dense tile keep the ray-traced backend switched off by design, and the museum is full of them. Fixing it means dispatching rays per dense tile instead of per frame, making the ray path alpha-aware or excluding masked instances one at a time, bounding the depth peel's cost, and stopping the dense mask from flickering. We track it as VG-BUG-1.
