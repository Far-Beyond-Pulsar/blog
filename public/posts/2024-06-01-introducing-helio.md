---
title: "Introducing Helio: A GPU-Driven Renderer Built in Rust"
date: "2026-06-06"
author: "Tristan Poland"
tags: ["renderer", "wgpu", "rust", "game-engine", "graphics"]
description: "A deep technical walkthrough of Helio — the custom GPU-driven deferred renderer we built for Pulsar. Why we built it, how its pipeline is structured, and what we learned along the way."
---

## Why Build a Renderer From Scratch?

When we started Pulsar, the natural move would have been to reach for an existing solution — Bevy's renderer, a Rend3 wrapper, or something thin over wgpu. We chose none of those. The reason is simpler than it might sound: every renderer embeds assumptions, and those assumptions eventually become constraints you didn't agree to. Deferred versus forward, bindless or not, how culling is structured, how materials are parameterized, what the scene representation looks like on the GPU — all of these are architectural decisions that flow through every downstream feature. Once a project matures past a certain point, you start hitting those walls.

The alternative is to own the stack. That comes with real costs — it takes longer, there's no community to lean on when something breaks at the driver level, and every feature is your problem to build. But it also means you can make the right call for *your* problem rather than working around someone else's past call. We decided the tradeoff was worth it. The result is Helio.

Helio is a modular, GPU-driven deferred renderer written entirely in Rust on top of wgpu. It's the renderer at the core of Pulsar, and this post is a detailed walkthrough of how it works — not a sales pitch, but an honest technical account of the design decisions and what they cost.

---

## The GPU-Driven Pipeline

The central idea behind Helio is that the CPU should do as little as possible per frame. Traditional renderers maintain a sorted draw call list on the CPU, upload it per frame, and rely on the driver to interpret it. This puts an O(n) floor on the CPU hot path regardless of what's actually visible. For a scene with ten thousand objects where six thousand are frustum-culled anyway, the CPU is still touching all ten thousand.

Helio flips this. The scene graph is uploaded once and delta-patched when it changes. A GPU compute pass then runs frustum culling and — optionally — Hi-Z occlusion culling across the full object list, writing a compact `DrawIndexedIndirect` buffer. The render pass consumes that buffer directly via `multi_draw_indexed_indirect`. The CPU's role per frame is reduced to dispatching compute and render passes, and uploading only the transforms that actually changed since the last frame.

In practice, that means a scene with ten thousand static objects costs the CPU roughly the same as a scene with a hundred. The GPU does the filtering. GPUs are very good at that.

The frame is structured as a sequence of typed passes run by a `RenderGraph`. Each pass implements a two-phase interface: a `prepare()` call that writes uniforms and updates bind groups, and an `execute()` call that records GPU commands into a shared `CommandEncoder`. The graph owns the encoder and passes it through a `PassContext`:

```rust
pub struct PassContext<'a> {
    pub scene: &'a SceneResources<'a>,
    pub device: &'a wgpu::Device,
    pub encoder: &mut wgpu::CommandEncoder,
    pub queue: &'a wgpu::Queue,
    pub target: &'a wgpu::TextureView,
    pub profiler: &'a mut Profiler,
}
```

Passes receive a shared reference to scene GPU resources and exclusive access to the encoder. There are no locks on the render path. Everything is batched and submitted together at the end of the frame.

The default pass sequence for an outdoor scene looks roughly like this. A shadow matrix compute pass runs first, computing per-cascade view-projection matrices for the directional light. The shadow pass then renders depth-only geometry into a 512×512×256-slice shadow atlas. The sky LUT pass bakes an atmospheric transmittance lookup texture (Hillaire 2020) at 192×108 — rebuilt only when sky parameters change. A depth prepass runs early-Z with GPU-driven indirect drawing, filling the depth buffer without touching the fragment shader for occluded geometry. The G-buffer pass fills four render targets: albedo, packed normals and F0, ORM (occlusion/roughness/metallic), and emissive. Finally, a fullscreen deferred lighting pass evaluates Cook-Torrance BRDF, applies cascaded shadow maps with PCSS, resolves radiance cascade global illumination, and tone-maps to the surface format.

That's the default. Optional passes can be inserted into the graph: Hi-Z construction and occlusion culling, TAA with jitter and reprojection, SSAO, screen-space reflections, an SDF clipmap for ray-marched distance field effects, transparent geometry, and a full water simulation stack. The modularity is compile-time — each pass is a separate crate.

---

## wgpu as the Foundation

We chose wgpu for three reasons. The first is portability. Vulkan, DX12, Metal, and WebGPU from a single API with a single codebase. Pulsar needs to run on every major desktop platform and eventually the web. Maintaining separate backends for each isn't something we want to own. The second is safety. wgpu's Rust API is designed around the borrow checker. You cannot use a buffer after freeing it. You cannot submit a command buffer that references resources that were dropped. This eliminates an entire class of GPU bugs that are otherwise nightmarish to reproduce and diagnose. The third is control. wgpu does not abstract away bindless textures, indirect dispatch, timestamp queries, or storage buffers. Every feature the hardware exposes is accessible.

Helio uses a small set of wgpu features that gate certain capabilities. `TEXTURE_BINDING_ARRAY` and `SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING` are required — the renderer uses bindless texture arrays and indexes into them with per-instance material IDs in the shader. `MULTI_DRAW_INDIRECT` and `MULTI_DRAW_INDIRECT_COUNT` are required for GPU-driven draw submission. When available, `TIMESTAMP_QUERY` is used for automatic GPU profiling. `SHADER_PRIMITIVE_INDEX` enables primitive ID access in fragment shaders, used by the G-buffer pass for sub-primitive effects.

We maintain a fork of wgpu under the Far-Beyond-Pulsar organization that carries a handful of patches not yet upstream. There's also experimental support for a second graphics backend via `blade-graphics`, which is being evaluated as an alternative API path. Neither of these details matter to Helio's users — the renderer abstracts both away completely.

---

## The Scene API

Helio's public API is entirely handle-based. Every resource — meshes, materials, objects, lights — is identified by a generational handle rather than a reference or pointer. Handles are `Copy` types that remain stable across deletions and can be stored anywhere without lifetime concerns.

```rust
pub struct MeshId     { slot: u32, generation: u32 }
pub struct MaterialId { slot: u32, generation: u32 }
pub struct ObjectId   { slot: u32, generation: u32 }
pub struct LightId    { slot: u32, generation: u32 }
```

All scene content is inserted through a single `insert_actor()` call that accepts a `SceneActor` enum and returns a `SceneActorId` identifying what was created. This makes it easy to write generic scene construction code and avoids proliferating specialized insertion functions.

Here's a complete example of creating a simple lit scene:

```rust
use helio::{Renderer, RendererConfig, Camera, PackedVertex, MeshUpload,
            GpuMaterial, ObjectDescriptor, SceneActor};
use libhelio::{LightType, Movability};
use glam::{Vec3, Mat4};

let mut renderer = Renderer::new(
    device.clone(),
    queue.clone(),
    RendererConfig::new(width, height, surface_format),
);

// Upload mesh geometry
let mesh_id = renderer.scene_mut()
    .insert_actor(SceneActor::mesh(MeshUpload {
        vertices: build_cube_vertices(),
        indices:  build_cube_indices(),
    }))
    .as_mesh()
    .unwrap();

// Define a metallic-roughness PBR material
let mat_id = renderer.scene_mut().insert_material(GpuMaterial {
    base_color:         [0.9, 0.15, 0.15, 1.0],
    emissive:           [0.0, 0.0, 0.0, 0.0],
    roughness_metallic: [0.5, 0.0, 1.5, 0.5],  // roughness, metallic, IOR, specular_tint
    tex_base_color:     GpuMaterial::NO_TEXTURE,
    tex_normal:         GpuMaterial::NO_TEXTURE,
    tex_roughness:      GpuMaterial::NO_TEXTURE,
    tex_emissive:       GpuMaterial::NO_TEXTURE,
    tex_occlusion:      GpuMaterial::NO_TEXTURE,
    workflow: 0,  // 0 = metallic-roughness, 1 = specular
    flags:    0,  // bit0=double-sided, bit1=alpha-blend, bit2=alpha-test
    _pad:     0,
});

// Place an instance in the scene with a bounding sphere for culling
let obj_id = renderer.scene_mut()
    .insert_actor(SceneActor::object(ObjectDescriptor {
        mesh:       mesh_id,
        material:   mat_id,
        transform:  Mat4::from_translation(Vec3::new(0.0, 1.0, -3.0)),
        bounds:     [0.0, 1.0, -3.0, 1.5],  // [cx, cy, cz, radius]
        flags:      0,
        groups:     GroupMask::NONE,
        movability: Some(Movability::Movable),
        user_tag:   0,
    }))
    .as_object()
    .unwrap();

// Add a warm point light
renderer.scene_mut()
    .insert_actor(SceneActor::light(GpuLight {
        position_range:  [0.0, 4.0, 0.0, 20.0],
        direction_outer: [0.0, -1.0, 0.0, 0.0],
        color_intensity: [1.0, 0.9, 0.8, 12.0],  // linear sRGB, intensity in candela
        shadow_index:    0,
        light_type:      LightType::Point as u32,
        inner_angle:     0.0,
        _pad:            0,
    }));

// Render
let camera = Camera::perspective_look_at(
    Vec3::new(0.0, 2.0, 6.0),
    Vec3::ZERO,
    Vec3::Y,
    60_f32.to_radians(),
    width as f32 / height as f32,
    0.1, 1000.0,
);
renderer.render(&camera, &surface_view)?;
```

The `render()` call is the entire frame. It flushes any dirty GPU data, runs the render graph, and presents. Nothing else to manage.

### Dirty Tracking and Delta Uploads

Scene changes are tracked on the CPU and only dirty ranges are re-uploaded to the GPU. A `DirtyTracker` records which slots in each GPU buffer have been modified since the last flush. At steady state — when nothing moves — `flush()` is effectively free. No data traversal, no uploads, no work. Only changes pay a cost proportional to their size.

This matters more than it might seem. In a Pulsar level with thousands of static props and a handful of dynamic objects, the frame cost of scene management becomes a function of what *changed*, not what *exists*. The static objects pay their upload cost once, at load time, and never again.

---

## Vertex and Instance Layout

Helio uses a compact, packed vertex format that fits inside 43 bytes. Normals and tangents are packed as SNORM8x4 rather than stored as full floats, which halves their storage cost at the cost of a small decode on the GPU.

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct PackedVertex {
    pub position:       [f32; 3],  // 12 bytes
    pub bitangent_sign: f32,       //  4 bytes — handedness of the tangent frame
    pub tex_coords0:    [f32; 2],  //  8 bytes — primary UV
    pub tex_coords1:    [f32; 2],  //  8 bytes — lightmap UV
    pub normal:         u32,       //  4 bytes — SNORM8x4 packed
    pub tangent:        u32,       //  4 bytes — SNORM8x4 packed
}
```

Instance data is stored in a single contiguous GPU storage buffer. Each entry holds a full model matrix, the inverse-transpose for normal transformation, a bounding sphere for culling, and references to the mesh and material:

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct GpuInstanceData {
    pub model:          [f32; 16],  // 64 bytes — column-major model matrix
    pub normal_mat:     [f32; 12],  // 48 bytes — inverse-transpose 3x3, padded
    pub bounds:         [f32;  4],  // 16 bytes — sphere: [cx, cy, cz, radius]
    pub mesh_id:        u32,
    pub material_id:    u32,
    pub flags:          u32,        // bit0=casts_shadow, bit1=receives_shadow
    pub lightmap_index: u32,
}
```

In the vertex shader, instances are fetched by index from the storage buffer. The vertex shader reads `@builtin(instance_index)` and uses it to index into the instance array directly. No per-draw uniforms, no push constants per instance — just a storage buffer read.

```wgsl
@group(0) @binding(0)
var<storage, read> instances: array<GpuInstanceData>;

@vertex
fn vs_main(
    @builtin(instance_index) instance_idx: u32,
    @location(0) position: vec3<f32>,
    @location(1) normal_packed: u32,
) -> VertexOutput {
    let inst     = instances[instance_idx];
    let world_pos = inst.model * vec4<f32>(position, 1.0);
    // ...
}
```

This design is a prerequisite for GPU-driven rendering. Because instances are addressed by index rather than by draw call state, the GPU can select which instances to draw through an indirect buffer without any CPU involvement.

---

## Virtual Geometry

Helio includes a meshlet-based virtual geometry system for high-polygon assets — conceptually similar to Nanite, though narrower in scope. When a mesh is uploaded as a `VirtualMesh`, it is automatically decomposed into clusters of at most 64 triangles each. A compute pass runs per-meshlet frustum culling and backface cone culling before the G-buffer pass, emitting one `DrawIndexedIndirect` command per visible cluster.

The culling data for each meshlet is precomputed at upload time:

```rust
pub struct GpuMeshletEntry {
    pub vertex_offset:   u32,
    pub index_offset:    u32,
    pub triangle_count:  u32,
    pub bounding_sphere: [f32; 4],
    pub cone_apex:       [f32; 3],
    pub cone_axis:       [f32; 3],
    pub cone_cutoff:     f32,  // cos(half_angle) for backface culling
    pub lod_error:       f32,  // 0.0=full detail, 1.0=medium, 2.0=coarse
}
```

The backface cone is built from the cluster's triangles: the apex is the cluster centroid, the axis is the area-weighted average normal, and the cutoff angle is computed conservatively — wide enough that no front-facing triangle can be missed. In the compute shader, a cluster is skipped if the view direction is within the cone's backface half-space.

LOD selection is automatic. The GPU chooses between three levels of detail (full, medium, coarse) based on the `lod_error` field relative to screen coverage. The CPU sets a global `lod_bias` scalar, but does no per-object LOD tracking — that work happens in the culling compute shader alongside visibility testing.

The result is that adding a high-poly mesh to the scene has O(1) CPU cost per frame. The GPU processes all clusters in parallel and emits only the draw commands that need to happen. For large scenes with many detailed assets, this is a significant win.

---

## Materials and Lighting

### PBR Materials

Helio uses the metallic-roughness PBR workflow (with optional specular mode). The `GpuMaterial` type is designed to be uploaded directly without conversion:

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct GpuMaterial {
    pub base_color:         [f32; 4],  // linear RGBA
    pub emissive:           [f32; 4],  // linear RGB + unused
    pub roughness_metallic: [f32; 4],  // roughness, metallic, IOR, specular_tint
    pub tex_base_color:     u32,       // texture array index, or NO_TEXTURE
    pub tex_normal:         u32,
    pub tex_roughness:      u32,
    pub tex_emissive:       u32,
    pub tex_occlusion:      u32,
    pub workflow:           u32,
    pub flags:              u32,
    pub _pad:               u32,
}
```

Texture references are indices into a global bindless texture array. Every texture uploaded to the scene gets a slot in this array and a `u32` index. The deferred lighting shader indexes into the array using the per-surface material ID fetched from the G-buffer. Non-uniform indexing — required by the `SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING` feature — is handled transparently.

### Lights

Lights are stored as packed GPU structs, keeping the light buffer tight. Point, spot, directional, and area lights share the same structure with a type discriminant:

```rust
#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable)]
pub struct GpuLight {
    pub position_range:  [f32; 4],  // xyz=position, w=range
    pub direction_outer: [f32; 4],  // xyz=direction, w=outer_cos (spot)
    pub color_intensity: [f32; 4],  // xyz=linear RGB, w=intensity
    pub shadow_index:    u32,       // 0=shadowed, u32::MAX=no shadow
    pub light_type:      u32,
    pub inner_angle:     f32,
    pub _pad:            u32,
}
```

Intensity is in physical units — candela for point and spot lights, lux for directional. This means lighting behaves predictably when you change the scene scale or move to a different environment.

### Cascaded Shadow Maps with PCSS

The shadow system uses four cascaded shadow maps. The split distances are chosen using a blend of uniform and logarithmic schemes (PSSM, lambda = 0.5):

```rust
const CSM_SPLITS: [f32; 4] = [16.0, 80.0, 300.0, 1400.0];
```

Shadow filtering uses Percentage-Closer Soft Shadows (PCSS) at higher quality settings. The implementation uses a two-pass approach: a blocker search samples the shadow map to estimate the average blocker depth, which then determines the penumbra radius for the PCF filter. Shadow quality is configurable through a preset enum:

```rust
pub enum ShadowQuality {
    Low,     // 4 PCF samples, no PCSS
    Medium,  // 8 PCF samples, no PCSS (default)
    High,    // 8 PCF + PCSS, 4 blocker / 8 filter samples
    Ultra,   // 16 PCF + PCSS, 8 blocker / 16 filter samples
}
```

At `High` and `Ultra` settings, TAA can halve the effective sample count by rotating the Vogel disk sample pattern each frame and accumulating over 16 frames, producing soft contact shadows without doubling the per-frame cost.

### Radiance Cascades Global Illumination

Helio implements a dual-tier GI system using radiance cascades. Within a configurable near-field radius (`rc_radius`, default ~80 units from the camera), full multi-bounce probe-based GI is evaluated. Outside that radius, a cheap ambient fallback is used. The two regions are blended smoothly over a configurable transition margin.

```rust
pub struct GiConfig {
    pub rc_radius:      f32,  // near-field quality boundary
    pub rc_fade_margin: f32,  // blend zone width
}
```

The radiance cascades update iteratively each frame — not all probes are updated in a single pass. Convergence is fast enough that the result is visually stable within a few frames after a large scene change, and completely stable at steady state.

---

## The Water System

The water system is one of the more elaborate subsystems in Helio. Water volumes are defined as AABB regions with a configurable surface height. The simulation runs as a GPU heightfield — each step propagates wave energy across the grid using spring-damper equations, applying a wind force that builds directional swells over time.

The descriptor covers simulation, visual, and physics parameters:

```rust
pub struct WaterVolumeDescriptor {
    pub bounds_min:     [f32; 3],
    pub bounds_max:     [f32; 3],
    pub surface_height: f32,

    // Simulation dynamics
    pub wave_spring:    f32,  // restoring force [0.5..2.0]
    pub wave_damping:   f32,  // energy retention per step [0.9..1.0]
    pub wind_direction: [f32; 2],
    pub wind_strength:  f32,
    pub wave_scale:     f32,

    // Visual
    pub water_color:    [f32; 3],
    pub extinction:     [f32; 3],  // Beer-Lambert absorption per meter (RGB)
    pub foam_threshold: f32,
    pub foam_amount:    f32,

    pub reflection_strength: f32,
    pub refraction_strength: f32,
    pub fresnel_power:       f32,

    pub caustics_enabled:   bool,
    pub caustics_intensity:  f32,
    pub caustics_scale:      f32,
    pub caustics_speed:      f32,

    pub fog_density:         f32,
    pub god_rays_intensity:  f32,

    pub ssr_enabled:   bool,
    pub ssr_steps:     u32,
    pub ssr_step_size: f32,
    pub ssr_thickness: f32,
}
```

Objects interacting with water are registered as hitboxes. Each hitbox stores its previous and current frame AABB. During the water simulation pass, the GPU computes the volume change between the two AABBs and applies a proportional displacement to the heightfield with a smooth Gaussian falloff at the edges. This gives a plausible wave-generation response when objects move through water — a boat pushing a bow wave, a character stepping into a pool.

Two presets cover the most common cases:

```rust
GpuWaterVolume::default_ocean()  // wind-driven open water
GpuWaterVolume::default_lake()   // calm, slow-moving surface
```

---

## Asset Loading

The `helio-asset-compat` crate bridges Helio's internal types with external asset formats via an in-house library called SolidRS. Supported formats include FBX, glTF 2.0 (both binary `.glb` and text `.gltf`), Wavefront OBJ, and USD/USDC.

The load API is straightforward:

```rust
use helio_asset_compat::{load_scene_file, load_and_upload_scene, LoadConfig};

// Load and upload in one step
let uploaded = load_and_upload_scene(
    "assets/prop.fbx",
    LoadConfig::default()
        .with_merge_meshes(true)
        .with_import_scale(Vec3::splat(0.01)),  // cm → m unit conversion
    &mut renderer,
)?;

// Or load to an intermediate representation first
let scene = load_scene_file("assets/environment.glb")?;
// inspect scene.meshes, scene.materials, scene.lights ...
// then upload manually
```

The intermediate `ConvertedScene` type holds mesh data, materials, lights, cameras, and textures in Helio's native formats, ready for direct upload. Multi-material assets come through as `ConvertedSectionedMesh` — a shared vertex buffer with separate index buffer per material section, mirroring Unreal Engine's sectioned mesh concept. A sectioned object has all its sections updated atomically when its transform changes, so multi-material props behave as a single unit.

---

## Visibility Groups

The group system is a bitmask-based visibility filter. Each object belongs to zero or more groups; each group can be shown or hidden globally. An object is visible when none of its groups are hidden.

```rust
pub struct GroupId(u8);  // 0..63

impl GroupId {
    pub const EDITOR:         GroupId = GroupId(0);
    pub const DEFAULT:        GroupId = GroupId(1);
    pub const STATIC:         GroupId = GroupId(2);
    pub const DYNAMIC:        GroupId = GroupId(3);
    pub const WORLD_UI:       GroupId = GroupId(4);
    pub const VFX:            GroupId = GroupId(5);
    pub const SHADOW_CASTERS: GroupId = GroupId(6);
    pub const DEBUG:          GroupId = GroupId(7);
}

renderer.hide_group(GroupId::EDITOR);   // hide editor-only objects in game mode
renderer.show_group(GroupId::DEBUG);    // show debug visualization objects
```

The group mask is a `u64` bitmask, so up to 64 groups are supported. Evaluating visibility is a single bitwise AND against the hidden group mask — no iteration, no per-object traversal. This makes mass show/hide operations free.

---

## Movability and the Caching Model

Helio adopts a three-tier movability model borrowed from Unreal Engine. Every object and light is classified as `Static`, `Stationary`, or `Movable`.

Static objects are expected never to move. They can participate in offline baking (via the optional `helio-bake` integration, codenamed Nebula) for lightmaps and reflection probes. The renderer makes no frame-to-frame effort to update them.

Stationary applies to lights — it means the light's position is fixed, but its shadow contribution can be dynamic. Stationary lights can cast precomputed static shadows while still affecting dynamic objects.

Movable objects pay the full cost of dynamic updates. Transforms are re-uploaded whenever changed, and shadow caches are invalidated each frame for movable shadow-casting lights.

Calling `update_transform()` on a Static object is a no-op with a warning rather than a crash. The classification is enforced at the API level to prevent accidental dynamic updates on objects the renderer isn't tracking frame-to-frame.

---

## Automatic Profiling

One of the more ergonomic decisions in Helio's design is that profiling is automatic. The `RenderGraph` wraps each pass with CPU timing and GPU timestamp queries without any instrumentation in the passes themselves. Every pass has a label, and those labels appear in the profiling output with accurate CPU and GPU durations.

Profiling data is exported to `helio-live-portal`, a separate real-time telemetry viewer. During development, you can pull up a live graph of per-pass frame times without adding a single line of profiling code to your application. Shadow pass taking 3ms? You'll see it immediately. G-buffer spiking on a specific asset? It shows up on the timeline.

The GPU timestamp implementation requires the `TIMESTAMP_QUERY` feature. When the feature is unavailable (some WebGPU contexts don't expose it), timestamps are silently omitted and the profiling data shows CPU-side times only.

---

## Platform Support

Because wgpu abstracts over Vulkan, DX12, and Metal, Helio targets all three without maintaining separate shader codepaths. WGSL is the shader language — it compiles to SPIR-V for Vulkan and GLSL-based paths for the others. The renderer runs on Windows (DX12), Linux (Vulkan), macOS (Metal), Android (Vulkan), and targets WebGPU for eventual browser support.

Metal on macOS surfaces a few restrictions that affect the feature set. Bindless texture arrays are supported but with lower maximum counts than Vulkan. `MULTI_DRAW_INDIRECT_COUNT` — the version of indirect drawing with a GPU-side draw count — is not universally available on Metal and the renderer falls back gracefully when it's absent.

---

## What's Next

Helio is functional as a production renderer today. It runs Pulsar's scene pipeline, handles large outdoor environments with thousands of objects, and supports the full lighting and shadow stack described above. But there's meaningful work left.

**Clustered lighting** is the immediate next priority. The current light list is evaluated per-pixel in the deferred pass for every light in the scene. A tile or cluster-based light assignment pass would bound the per-pixel light cost to only lights that overlap a given screen tile, enabling thousands of dynamic lights without linear per-pixel cost.

**GPU-driven skeletal animation** is the next major feature for character-heavy scenes. Skinning currently runs on the CPU and uploads transformed vertex data each frame. Moving it to a compute pass would let the GPU evaluate bone matrices and blend shapes in parallel across all visible skinned meshes, with no CPU involvement in the deformation step.

**Virtual shadow maps** — a sparse shadow atlas where only shadow map texels that cover visible surfaces are allocated — would let thousands of shadow-casting lights exist in a scene without proportionally scaling atlas memory or shadow render cost.

**Hardware raytraced ambient occlusion** via DXR / VK_KHR_ray_tracing is on the roadmap for platforms that support it. The current SSAO pass is fast and integrates with the deferred pipeline, but hardware RT removes its screen-space artifacts and handles geometry outside the camera's view.

We're building in the open. The renderer source lives in [Pulsar-Native](https://github.com/Far-Beyond-Pulsar/Pulsar-Native). If any of this architecture is interesting to you — or if you see something we're doing wrong — we'd genuinely like to hear from you.
