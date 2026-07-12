---
title: "Radiance Cascades: Probe-Based Global Illumination"
date: "2026-06-29"
author: "Tristan Poland"
tags: ["rust", "helio", "graphics", "architecture", "pulsar"]
description: "A technical walkthrough of Helio's probe-based global illumination system — how a sparse grid of radiance probes captures indirect light, the cascade atlas format, multi-bounce accumulation, ambient fallback outside the grid, and why we're waiting on hardware ray tracing for the next step."
thumbnail: /post_thumb/radiance_cascades.png
---

## Why Baked Lighting Isn't Enough

Lightmaps produce beautiful indirect lighting. A path-traced bake running overnight can capture dozens of bounces, subsurface scattering, and subtle colour bleeding that makes a static scene look grounded and real. The problem, as anyone who has put a dynamic object into a lightmapped scene knows, is the moment something moves. A character standing in a corridor lit by bounced light from an unseen window will carry that baked lighting with them no matter where they go. The GI is pinned to world-space texels and the character is not.

SSAO helped when it arrived — it breaks up the flatness by darkening corners and contact points — but it only operates at the scale of a few pixels. It cannot tell you that the undersides of a table should be warm from light bouncing off the floor, or that a dark alcove should still have faint sky colour filtering in from outside. Those are large-scale indirect lighting effects, and they require a volumetric representation of light in the scene.

Helio's answer is Radiance Cascades: a sparse grid of probes that sample and accumulate indirect radiance over time, writing the result into a compact atlas that the deferred lighting pass samples per pixel. It is not a complete replacement for baked lighting — the quality gap between a converged offline bake and a real-time probe grid is still large — but it fills the gap for dynamic objects and moving cameras in a way that static lightmaps cannot.

This is how it works, where it is today, and where it is going.

---

## Probe Grid Layout

The fundamental unit of the Radiance Cascades system is the probe — a point in world space that stores incoming radiance from a fixed set of directions. Probes are arranged in a uniform grid centered on the camera. The grid is 8×8×8, giving 512 probes total per frame:

```rust
/// Probe grid dimension (one axis). Probes are PROBE_DIM³.
const PROBE_DIM: u32 = 8;
/// Direction bins per atlas axis.
const DIR_DIM: u32 = 4;
```

Each probe stores 4×4 = 16 direction bins, encoded using octahedral mapping (Y-up pole, matching the scene convention). Octahedral encoding maps the unit sphere onto a 2D square without the seam artifacts of latitude-longitude projection, and without the singularities of cube-map face selection. The decode is a handful of ALU ops:

```wgsl
fn oct_decode(uv: vec2<f32>) -> vec3<f32> {
    let f  = uv * 2.0 - 1.0;
    let af = abs(f);
    let l  = af.x + af.y;
    var n: vec3<f32>;
    if l > 1.0 {
        let sx = select(-1.0, 1.0, f.x >= 0.0);
        let sz = select(-1.0, 1.0, f.y >= 0.0);
        n = vec3<f32>((1.0 - af.y) * sx, 1.0 - l, (1.0 - af.x) * sz);
    } else {
        n = vec3<f32>(f.x, 1.0 - l, f.y);
    }
    return normalize(n);
}
```

The grid follows the camera. Each frame the `prepare()` function computes `world_min` and `world_max` from the camera position plus `rc_radius`:

```rust
fn prepare(&mut self, ctx: &PrepareContext) -> HelioResult<()> {
    let dyn_data = RCDynamic {
        world_min: [-10.0, -1.0, -10.0, 0.0],
        world_max: [10.0, 10.0, 10.0, 0.0],
        frame: ctx.frame_num as u32,
        light_count,
        sky_color: [sky[0], sky[1], sky[2], 0.0],
    };
    ctx.write_buffer(&self.uniform_buf, 0, bytemuck::bytes_of(&dyn_data));
    Ok(())
}
```

The hardcoded ±10 values in the snippet above are the current fallback — in the real implementation these are derived from the camera position and the `rc_radius` config parameter. The grid snaps to the camera position so that the highest probe density is always where the viewer is.

Each probe stores a `vec4<f32>` per direction bin: `rgb = radiance, w = throughput`. Throughput tracks whether the ray hit geometry (0.0) or escaped to the sky (1.0), enabling the multi-bounce merge that ties cascade levels together.

---

## Cascade Atlas Format

The 512 probes × 16 directions each would be a lot of individual textures or buffer reads. Instead, everything packs into a single 2D texture: a *cascade atlas*.

```
Atlas width  = PROBE_DIM * DIR_DIM = 8 * 4 = 32
Atlas height = PROBE_DIM² * DIR_DIM = 64 * 4 = 256
```

The layout is a 2D mapping from (probe_x, probe_y, probe_z, dir_x, dir_y) to a texel coordinate:

```
atlas_x = probe_x * DIR_DIM + dir_x
atlas_y = (probe_y * PROBE_DIM + probe_z) * DIR_DIM + dir_y
```

This is declared as a render-graph-managed texture in `declare_resources()`:

```rust
fn declare_resources(&self, builder: &mut ResourceBuilder) {
    builder.write_color_raw(
        "rc_cascades",
        wgpu::TextureFormat::Rgba16Float,
        ResourceSize::Absolute { width: ATLAS_W, height: ATLAS_H },
    );
    builder.with_extra_usage(wgpu::TextureUsages::STORAGE_BINDING);
}
```

`Rgba16Float` gives enough dynamic range for HDR radiance values while keeping the texture small — 32×256×8 bytes = 64 KB per slice. The format supports one cascade level per slice. The full `rc_trace.wgsl` shader supports multiple cascade levels (coarse → fine), each at a different probe resolution, writing into its own atlas slice. The current fallback uses only the base level.

The graph executor maps this texture into `FrameResources` so downstream passes can find it:

```rust
// in graph executor:
"rc_cascades" => frame.rc_view.write(view, "Graph"),
```

---

## GiConfig

The system is configured through `GiConfig`, which lives in `crates/helio/src/renderer/config.rs`:

```rust
/// Global Illumination configuration (dual-tier: RC near, ambient far).
#[derive(Debug, Clone, Copy)]
pub struct GiConfig {
    /// Radiance Cascades volume radius around camera (world units).
    /// GI within this radius uses RC, outside uses cheap ambient fallback.
    /// Default: 80.0 (near-field quality like Unreal Lumen).
    pub rc_radius: f32,
    /// Fade margin for smooth RC→ambient transition (world units).
    /// Default: 20.0 (soft blend zone).
    pub rc_fade_margin: f32,
}
```

The two-tier design is deliberate. The probe grid is camera-centered with a configurable radius — inside that radius the system evaluates the cascade atlas for indirect lighting. Outside it, the renderer falls back to a simple hemisphere ambient. The `rc_fade_margin` controls the smooth blend zone between the two, preventing a hard cutoff line as objects exit the grid.

The constructor provides sensible defaults (`rc_radius: 80.0`, `rc_fade_margin: 20.0`), and the convenience constructor `ambient_only()` sets the radius to zero to disable RC entirely for low-end hardware. The `large_radius()` constructor sets the fade margin to 25% of the radius automatically.

The `RendererConfig` struct carries this as a field and exposes a builder-style `with_gi_config()` for ergonomic setup:

```rust
let renderer = RendererBuilder::new()
    .with_gi_config(GiConfig { rc_radius: 120.0, rc_fade_margin: 30.0 })
    .build(device, queue, &scene)
    .await?;
```

---

## Multi-Bounce Evaluation

Single-bounce GI captures one extra light interaction: light from the source hits a surface, then bounces to the probe. That already improves over direct-only lighting, but it misses the light that bounces twice, three times, or more before reaching the eye.

The full `rc_trace.wgsl` shader handles this through the cascade hierarchy. Each cascade level operates at a different probe density. A coarse level covers the full volume with widely spaced probes; a fine level doubles the density. During the trace, each probe reads its parent's radiance at the same direction and blends it in:

```wgsl
// Merge (coarse->fine):
//   merged_rad = local_rad + parent_rad * local_throughput
//   merged_thr = local_throughput * parent_throughput
if rc_stat.cascade_index < 3u && rc_stat.parent_dir_dim > 0u {
    let parent = read_parent_probe(pi_clamped.x, pi_clamped.y, pi_clamped.z, dx, dy, pdim, ppdim);
    radiance   = radiance + parent.rgb * throughput;
    throughput = throughput * parent.w;
}
```

The throughput channel is the key. A ray that hits geometry has `throughput = 0.0`, which means the parent radiance is completely attenuated — no light passes through opaque surfaces. A ray that escapes to the sky has `throughput = 1.0` and inherits the full parent radiance. This naturally encodes occlusion as a byproduct of ray traversal without needing to store hit distances or normal vectors per probe.

This propagation is not instantaneous — it builds up over multiple frames. The shader applies an exponential moving average between the current and previous frame's cascade data:

```wgsl
let hist = textureLoad(cascade_history, vec2<i32>(i32(gid.x), i32(gid.y)), 0);
let alpha = 0.15;
radiance   = mix(hist.rgb, radiance,   alpha);
throughput = mix(hist.w,   throughput, alpha);
```

An alpha of 0.15 means roughly six frames for full convergence. In practice the difference between frame 3 and frame 6 is subtle — the bulk of the energy resolves in the first few frames after a camera cut, and the remaining frames polish the residual.

The system writes the new value into both `cascade_out` (the main atlas consumed by the deferred pass) and `cascade_history_write` (a ping-pong buffer for the next frame's history), avoiding an explicit `copy_texture_to_texture` blit.

---

## Ambient Fallback Outside the Grid

The probe grid covers a finite volume. Outside that volume — objects far from the camera, or geometry that falls between probes — the radiance cascade cannot provide meaningful data. Leaving those pixels black creates a hard visual seam that screams "buggy renderer."

Helio handles this with a three-tier blend in the deferred lighting pass:

```wgsl
let sky_color    = globals.ambient_color.rgb * globals.ambient_intensity;
let ground_color = sky_color * 0.15;
let hemi_t       = N.y * 0.5 + 0.5;
let hemi         = mix(ground_color, sky_color, hemi_t) * albedo;

let rc_weight    = clamp(length(rc_irr) * 4.0, 0.0, 1.0);
let lm_weight    = select(0.0, 1.0, has_lightmap);

var ambient_final = mix(hemi, diff_ind, rc_weight);
```

1. **Hemisphere ambient** — always-on fallback. Sky colour on the upper hemisphere, a dimmed version on the lower. Simple, cheap, and never black.
2. **RC indirect** — blends in via `rc_weight`, which ramps up with the magnitude of the RC sample. Inside the grid with valid data, the weight approaches 1.0. At the grid boundary, it smoothly fades to 0.0.
3. **Baked lightmap** — when available (static geometry with pre-baked lightmaps), the lightmap takes full priority with `lm_weight = 1.0`, suppressing the dynamic indirect path entirely to avoid double-counting.

The `rc_weight` heuristic — `clamp(length(rc_irr) * 4.0, 0.0, 1.0)` — is deliberately simple. It works because valid radiance cascade data always has non-zero energy at surfaces (even shadowed areas receive some indirect light). When the cascade writes black (the current fallback state), `rc_weight` stays at zero and the hemisphere takes over transparently.

---

## The Experimental Ray Query Dependency

The full Radiance Cascades shader — `rc_trace.wgsl` — requires a feature that wgpu does not yet expose in its stable API:

```wgsl
enable wgpu_ray_query;
```

This is the WGSL extension for hardware-accelerated ray queries: `rayQueryInitialize`, `rayQueryProceed`, and `rayQueryGetCommittedIntersection`. It maps to Vulkan's `VK_KHR_ray_query` and DirectX 12's `D3D12_RAYTRACING_SHADER_CONFIG` — the same GPU ray tracing hardware that powers Unreal's Lumen hardware ray tracing mode.

The shader uses ray queries to trace rays from each probe, intersecting against a top-level acceleration structure (TLAS) built from the scene's geometry. Each probe casts 16 rays (one per direction bin) to sample the indirect light field:

```wgsl
var rq: ray_query;
rayQueryInitialize(&rq, acc_struct,
    RayDesc(0x01u, 0xFFu, 0.001, t_max, probe_pos, dir));
rayQueryProceed(&rq);
let isect = rayQueryGetCommittedIntersection(&rq);
```

The problem is that `wgpu::Features::EXPERIMENTAL_RAY_QUERY` and the `wgpu::Tlas` type were added after wgpu 23.0.1, which is the version Helio currently targets. We cannot ship the real shader until the wgpu dependency is upgraded.

For now, the fallback compute shader clears the cascade atlas to the sky colour attenuated by 5% — a dim ambient that never produces valid GI data, but ensures the texture is well-formed and that downstream passes never read uninitialized memory:

```wgsl
textureStore(cascade_out, vec2<i32>(i32(gid.x), i32(gid.y)),
    vec4<f32>(rc_dyn.sky_color.rgb * 0.05, 1.0));
```

The bind group already reserves bindings for the TLAS (`@binding(4) var acc_struct: acceleration_structure`) and the light storage buffer. When the wgpu upgrade lands, swapping in the real shader is a matter of changing the shader module and building the bind group with a `wgpu::Tlas` — the pipeline structure is ready.

I am not going to pretend this is shipping. It is not. The system compiles, the resources are wired, and the shader is written and reviewed, but today it writes black (well, dim sky colour). The ambient fallback covers the visual gap, but hardware ray-traced indirect lighting is a post-1.0 feature for Helio.

---

## Connection to the Deferred Lighting Pass

The deferred lighting pass (`helio-pass-deferred-light`) is where the cascade atlas is consumed. The pass binds the RC texture at `@group(2) @binding(5)`:

```wgsl
@group(2) @binding(5) var rc_cascade0: texture_2d<f32>;
```

Each fragment reconstructs its world position from the G-buffer depth, transforms it into probe-grid space, performs trilinear interpolation across the 8 surrounding probes, and integrates the 16 direction bins using cosine-weighted sampling:

```wgsl
fn sample_rc_irradiance(world_pos: vec3<f32>, normal: vec3<f32>) -> vec3<f32> {
    let world_min  = globals.rc_world_min.xyz;
    let world_max  = globals.rc_world_max.xyz;
    let world_size = world_max - world_min;
    if world_size.x <= 0.0 || world_size.y <= 0.0 || world_size.z <= 0.0 {
        return vec3<f32>(0.0);
    }
    let t = (world_pos - world_min) / world_size;
    // ... fade margin, cosine weights, trilinear probe blend ...
}
```

The integration reconstructs irradiance from the 16 direction bins by weighing each bin by `max(0.0, dot(normal, bin_direction))` — effectively reconstructing the incident radiance over the hemisphere. This is the same operation as filtering an environment map, but sampled from the probe grid rather than a cubemap.

The final diffuse indirect contribution is the standard Cook-Torrance diffuse IBL formula:

```wgsl
let rc_irr   = sample_rc_irradiance(world_pos, N);
let F_ibl    = fresnel_schlick_roughness(NdV, F0, roughness);
let kD_ibl   = (1.0 - F_ibl) * (1.0 - metallic);
let diff_ind = kD_ibl * rc_irr * albedo;
```

The RC data feeds the diffuse term only. Specular indirect is handled by the environment cubemap — hardware ray-traced specular GI is a separate problem with its own cost-to-quality tradeoffs.

---

## How This Differs from HLFS

Helio has a second indirect-light system: Hierarchical Light-Field Sampling (HLFS), implemented in `helio-pass-hlfs`. HLFS was described in a previous post, but the short version is that it builds a camera-centric 3D clip-stack of radiance by importance-sampling lights and injecting their contributions into a sparse voxel hierarchy.

The two systems serve different purposes:

- **Radiance Cascades** targets *indirect light transport*. Probes are placed in a fixed grid around the camera and accumulate radiance from ray-traced scene intersections. The output is a low-frequency irradiance field that captures colour bleeding, ambient occlusion from distant geometry, and sky light penetration. It is view-independent within the grid volume — any point inside the grid can query it.

- **HLFS** targets *many-light direct lighting*. The clip-stack captures direct radiance from hundreds or thousands of light sources, clustering them into a hierarchical texture so the shading cost is O(1) per pixel regardless of light count. HLFS does not model inter-reflections — it is a direct-light acceleration structure.

In practice these systems complement each other. HLFS handles the high-frequency direct lighting from many small lights. Radiance Cascades handles the low-frequency indirect bounce light that fills shadows and connects surfaces. When both are active, the deferred pass can query HLFS for direct multi-light shading and the RC cascade for indirect diffuse, giving a unified lighting result without double-counting.

Currently, only HLFS is operational in Helio's shipping builds. The RC pass compiles and wires through the graph, but the ray-query dependency means it produces ambient-only output. The architecture is ready; the wgpu version is not.

---

## Performance and Convergence

The Radiance Cascades pass is designed for minimal CPU overhead. The `execute()` function dispatches a single compute shader with a constant workgroup count derived from the atlas size — no CPU loops, no dynamic dispatch:

```rust
let wg_x = ATLAS_W.div_ceil(WORKGROUP_SIZE_X);  // 32 / 8 = 4
let wg_y = ATLAS_H.div_ceil(WORKGROUP_SIZE_Y);  // 256 / 8 = 32
pass.dispatch_workgroups(wg_x, wg_y, 1);
```

Four workgroups in X, 32 in Y — 128 workgroups total. Each workgroup processes 64 threads (8×8). The theoretical GPU utilization is extremely high because every thread maps to exactly one atlas texel with no divergence (the fallback path has zero branching; the real RT path has some divergence from ray miss vs. hit, but the octahedral direction encoding keeps thread coherence within each workgroup).

The atlas is 64 KB per cascade level. For a system targeting 4 cascade levels, that is 256 KB of GPU memory — negligible by modern standards. The ping-pong history doubles it to 512 KB.

Temporal convergence uses exponential moving average with a fixed alpha of 0.15:

```
frame_n = lerp(frame_{n-1}, sample_n, 0.15)
```

This gives a half-life of roughly 4.3 frames and near-full convergence at ~30 frames (6× half-life). In practice, the perceptible improvement stops after about 10 frames under continuous motion, and the remaining convergence smooths residual noise that is barely visible at display refresh rates.

Camera cuts and teleports are handled implicitly — the history buffer is per-frame and the EMA will fully replace stale data within a few frames. There is no explicit reset mechanism because the exponential decay means old data is exponentially attenuated.

---

## Where It Goes Next

The immediate roadmap is the wgpu 24+ upgrade that unlocks `wgpu::Tlas` and hardware ray queries. That is the single dependency gating the real `rc_trace.wgsl` shader. Once that lands, the system will:

- Build a TLAS from the scene's static and dynamic geometry each frame (incremental updates when possible)
- Trace 8,192 rays per frame (512 probes × 16 directions) through the TLAS
- Accumulate direct light contributions at each ray hit point using the scene's active lights
- Propagate through the cascade hierarchy for multi-bounce transport
- Optionally scale the probe count and ray count based on quality settings

The probe grid resolution and ray count are tunable knobs that directly trade quality for performance. An 8³ grid with 16 directions per probe is conservative — 16³ × 64 directions is the upper bound before the atlas becomes unwieldy. The cascade hierarchy already supports variable probe density per level, which means we can concentrate probes near the camera and coarsen toward the grid boundary, using fewer total probes while maintaining quality in the visible region.

The ambient fallback and hemisphere blend ensure that the system degrades gracefully at every stage — no hardware RT support? Hemisphere ambient. Outside the probe grid? Hemisphere ambient. Between cascade levels? Parent-probe blend. Every failure mode produces soft falloff rather than hard black edges, which is the only acceptable outcome for a shipping renderer.
