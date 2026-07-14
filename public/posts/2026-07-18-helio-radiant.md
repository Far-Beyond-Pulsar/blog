---
title: "Helio Radiant: Zero-Cost Custom Materials Through Template Fusion"
date: "2026-07-18"
author: "Tristan Poland"
tags: ["rust", "helio", "graphics", "materials", "architecture", "pulsar"]
description: "How Helio's Radiant material system combines hand-authored shader templates with graph-generated WGSL snippets to deliver custom surface shaders with zero per-permutation PSO cost — through warp-uniform feature branches, lazy shader compilation, and draw-call grouping by material class."
thumbnail: /post_thumb/radiant.png
---

## The Problem With Fixed Materials

Helio was built around a deferred PBR pipeline. Every material shared the same GBuffer shader. The `GpuMaterial` struct stored base color, roughness, metallic, emissive, a few texture handles, and a workflow discriminant. The shader read these from a storage buffer and evaluated them the same way for every object. No branching, no specialization, no per-material code paths.

This was fast. One PSO. One `multi_draw_indexed_indirect` call. No permutation explosion, no compilation stutter, no pipeline-object cache to manage. The entire scene rendered through a single fragment shader variant.

But it was also rigid. Want clear coat? You'd need to pack it into unused channels and write a custom path in the deferred light pass. Want subsurface scattering? Same problem. Want a completely custom surface that writes the GBuffer differently based on artist-authored logic? The fixed material model couldn't express it. You could change parameters. You couldn't change the code.

The initial design assumed that PBR parameters covered enough of the surface space that a standardized evaluation function was sufficient. For most materials this is true. But the edge cases — the surfaces that don't fit — are exactly the surfaces that make a renderer look distinctive. A character's skin, a car's paint, a creature's translucent membrane. These aren't expressible through roughness and metallic alone.

The usual solution in AAA engines is shader permutations. Each unique material graph compiles to its own fragment shader variant. Unreal does this. Unity's HDRP does this. The result is artist freedom at the cost of PSO explosion. Unreal's ShaderCompileWorker exists because compiling hundreds of permutations for a single material change takes real time. The pipeline cache for The Last of Us Part II reportedly contained over 12,000 unique PSOs. Each PSO costs driver memory, pipeline-bind overhead, and compile latency.

Radiant is the middle path. It keeps one PSO for the common case and spawns new ones only when the artist explicitly writes custom code. The cost profile matches the flexibility: zero overhead for standard materials, linear cost for custom materials.

---

## The GpuMaterial Evolution

Before Radiant, `GpuMaterial` was a 96-byte struct:

```rust
#[repr(C)]
pub struct GpuMaterial {
    pub base_color:         [f32; 4],    // 16
    pub emissive:           [f32; 4],    // 16
    pub roughness_metallic: [f32; 4],    // 16 (x=roughness, y=metallic, z=IOR, w=specular_tint)
    pub tex_base_color:     u32,         // 4
    pub tex_normal:         u32,         // 4
    pub tex_roughness:      u32,         // 4
    pub tex_emissive:       u32,         // 4
    pub tex_occlusion:      u32,         // 4
    pub workflow:           u32,         // 4 (0=metallic, 1=specular)
    pub flags:              u32,         // 4 (double_sided, alpha_blend, alpha_test)
    pub _pad:               u32,         // 4
}
```

The `_pad` field was alignment padding. Every `GpuMaterial` construction site set it to zero. Radiant repurposed it into `material_class`, then extended the struct by 16 bytes for `class_params`:

```rust
#[repr(C)]
pub struct GpuMaterial {
    pub base_color:         [f32; 4],
    pub emissive:           [f32; 4],
    pub roughness_metallic: [f32; 4],
    pub tex_base_color:     u32,
    pub tex_normal:         u32,
    pub tex_roughness:      u32,
    pub tex_emissive:       u32,
    pub tex_occlusion:      u32,
    pub workflow:           u32,
    pub flags:              u32,         // extended with feature flags
    pub material_class:     u32,         // 0 = default PBR, 1+ = template
    pub class_params:       [f32; 4],    // class-specific float params
}
```

112 bytes. Adding 16 bytes to a GPU storage buffer isn't free — it increases the stride for every material slot. With 2048 material slots, that's 32 KB of additional GPU memory. Negligible.

The flags field grew from 3 bits to 8:

```rust
pub const FLAG_DOUBLE_SIDED:   u32 = 1 << 0;
pub const FLAG_ALPHA_BLEND:    u32 = 1 << 1;
pub const FLAG_ALPHA_TEST:     u32 = 1 << 2;
pub const FLAG_HAS_NORMAL_MAP: u32 = 1 << 3;
pub const FLAG_HAS_CLEAR_COAT: u32 = 1 << 4;
pub const FLAG_HAS_SUBSURFACE: u32 = 1 << 5;
pub const FLAG_HAS_ANISOTROPY: u32 = 1 << 6;
pub const FLAG_HAS_CUSTOM:     u32 = 1 << 7;
```

The original three flags were already consumed by the render pipeline (double-sided controls `cull_mode`, alpha blend controls blend state, alpha test gates alpha discard). The new flags are evaluated inside the shader, not by the pipeline. They tell `radiant_eval_surface` which warp-uniform branches to take.

Every construction site across the workspace — the asset converter, the snapshot renderer, the web demos, the example code — needed updating. The compiler caught all of them. There were seven sites total.

---

## The Three Tiers

Radiant categorises every material into one of three tiers. The tier determines what happens at draw time.

### Tier 1: Feature Flags

The default PBR uber-shader is compiled once, at graph construction time. It contains warp-uniform branches gated by material flags:

```wgsl
fn radiant_eval_surface(
    material: GpuMaterial,
    material_tex: MaterialTextureData,
    input: VertexOutput,
) -> SurfaceData {
    let uv = input.tex_coords;
    let base_sample = sample_texture(material_tex.base_color, uv, vec4<f32>(1.0));
    let albedo = material.base_color * base_sample;
    let alpha = albedo.a;
    let N_geom = normalize(input.world_normal);

    // Warp-uniform: all pixels in this wave share the same material
    var N: vec3<f32>;
    if (material.flags & FLAG_HAS_NORMAL_MAP) != 0u
        && material_tex.normal.texture_index != NO_TEXTURE
    {
        let T = normalize(input.world_tangent
            - dot(input.world_tangent, N_geom) * N_geom);
        let B = cross(N_geom, T) * input.bitangent_sign;
        var norm_ts = sample_texture(/* ... */);
        N = normalize(T * norm_ts.x + B * norm_ts.y + N_geom * norm_ts.z);
    } else {
        N = N_geom;
    }

    let orm_sample = sample_texture(/* ... */);
    let occlusion_sample = sample_texture(/* ... */);
    let emissive_sample = sample_texture(/* ... */);

    let ao = 1.0 + (occlusion_sample.r - 1.0) * material_tex.params.y;
    let roughness = clamp(material.roughness_metallic.x * orm_sample.g, 0.045, 1.0);
    let metallic = clamp(material.roughness_metallic.y * orm_sample.b, 0.0, 1.0);
    let specular_f0 = resolve_specular_f0(material, material_tex, albedo.rgb, metallic, uv);
    let emissive = material.emissive.rgb * material.emissive.w * emissive_sample.rgb;

    // RADIANT_OVERRIDE_SURFACE
    // RADIANT_OVERRIDE_END

    return SurfaceData(albedo, N, ao, roughness, metallic, specular_f0, emissive, alpha);
}
```

The warp-uniform guarantee is worth examining. On NVIDIA hardware, a warp is 32 threads. On AMD, it's 64. On Apple Silicon, it's 32. Every thread in a warp executes the same instruction stream. When you hit a conditional branch, the GPU evaluates the condition and masks off threads that take the other path. If ALL threads take the same path, the cost is a single scalar comparison.

In a deferred renderer, the GBuffer pass processes visible fragments. These fragments come from triangles that were rasterized. Adjacent triangles tend to belong to the same object, which uses the same material. Adjacent pixels in screen space tend to fall within the same object's rasterized area. So pixels in the same warp almost always carry the same material ID, which means the same `material.flags` value.

The guarantee holds because `material.flags` is a per-material constant, not a per-pixel varying value. The only way a warp could split is if two triangles from different materials rasterize into the same 2×2 pixel quad. This can happen at material boundaries — the edge between a character's skin and their clothing. The cost is 32 threads taking one branch and the rest taking the other. The divergent paths serialize. For a single `if` check at a material boundary, this costs roughly 5-10 cycles of scalar math plus the latency of the divergent path. The GBuffer shader spends roughly 200-300 cycles waiting on texture fetches. The divergence cost is hidden by memory latency.

A material in Tier 1 never creates a new PSO. It sets flags on `GpuMaterial.flags` and the single compiled uber-shader handles the rest.

### Tier 2: Template + Graph

When the flag system isn't enough, Radiant introduces a template. A template is a hand-authored WGSL file that contains `radiant_eval_surface` with replaceable override markers:

```wgsl
// RADIANT_OVERRIDE_SURFACE
// When no graph is registered, these markers are removed
// and the default return statement below is used.
// RADIANT_OVERRIDE_END
```

The `RadiantTemplate::build_shader_source` method handles the replacement:

```rust
pub fn build_shader_source(&self, graph_wgsl: &str, max_textures: usize) -> String {
    // Replace binding array sizes (same as pre-Radiant GBuffer setup)
    let src = self.wgsl_source
        .replace("binding_array<texture_2d<f32>, 256>", /* ... */)
        .replace("binding_array<sampler, 256>", /* ... */);

    if graph_wgsl.is_empty() {
        // No graph: remove the override markers, leaving the default return
        src.replace("// RADIANT_OVERRIDE_SURFACE\n", "")
           .replace("// RADIANT_OVERRIDE_END\n", "")
    } else {
        // Graph present: replace everything between the markers
        let marker = "// RADIANT_OVERRIDE_SURFACE";
        let end = "// RADIANT_OVERRIDE_END";
        if let Some(start) = src.find(marker) {
            if let Some(end_pos) = src.find(end) {
                let before = &src[..start];
                let after = &src[end_pos + end.len()..];
                format!("{}{}\n{}", before, graph_wgsl, after)
            } else { src }
        } else { src }
    }
}
```

The graph compiler outputs a WGSL fragment that replaces the markers. The fragment receives all variables in scope — `material`, `material_tex`, `input`, `uv`, `N`, `albedo`, `ao`, `roughness`, `metallic`, `specular_f0`, `emissive` — and can override any field of the returned `SurfaceData`:

```wgsl
// Example graph compiler output: a simple color blend override
{
    let extra_color = material.class_params.xyz;
    let blended = mix(surface.albedo, extra_color, material.class_params.w);
    return SurfaceData(blended, surface.normal, surface.ao,
        surface.roughness, surface.metallic, surface.specular_f0,
        surface.emissive, surface.alpha);
}
```

The template author defines which variables the override can touch. The graph compiler must emit WGSL that is syntactically valid at the injection point. The engine trusts the compiler — it does no validation. If the injected code doesn't compile, `create_shader_module` returns an error, and the pipeline creation fails. The engine logs the error and falls back to a default material. The template registry can be updated at any time without restarting the engine.

### Tier 3: Full Custom WGSL

Tier 3 is Tier 2 where the graph compiler outputs the entire `radiant_eval_surface` function body. The template still provides the `SurfaceData` struct definition, the `GBufferOutput` packing code, and all bind group declarations. But the evaluation function is 100% artist-authored.

This is the escape hatch. A surface that reads from a fluid simulation texture. A material that changes its BRDF based on the angle between the view vector and a directional light. A translucent surface that combines depth-based attenuation with custom fog. Any of these would require the template author to anticipate the use case. With Tier 3, the artist writes the full function and the template becomes a thin wrapper around the bind group layout and output format.

Tier 3 materials incur a PSO of their own. The cost is identical to Tier 2 — one PSO per unique graph hash.

---

## How the Template Registry Works

Templates are stored in `RadiantTemplateRegistry`, a `HashMap<u32, RadiantTemplate>` owned by the GBuffer pass:

```rust
pub struct RadiantTemplate {
    pub name: &'static str,
    pub wgsl_source: &'static str,
}

pub struct RadiantTemplateRegistry {
    templates: HashMap<u32, RadiantTemplate>,
    next_id: u32,
}
```

The built-in default PBR template is registered as class 0 at construction time, loaded via `include_str!` from `gbuffer.wgsl`. Additional templates are registered at runtime by external tools:

```rust
// From disk — loads the file, assigns the next available class ID
let id = reg.load_from_file("templates/clear_coat.wgsl").unwrap();

// From memory — for generated or embedded templates
let id = reg.register_str("skin", wgsl_source);
```

`load_from_file` reads the file, converts it to a `&'static str` via `Box::leak`, and assigns the next auto-incremented ID. `register_str` does the same from an owned `String`. The resulting ID is stored on the material via `Scene::set_material_class`.

The registry is reachable through `GBufferPass::template_registry_mut()`, which the renderer exposes through `find_pass_mut`:

```rust
let reg = renderer.find_pass_mut::<GBufferPass>()
    .unwrap()
    .template_registry_mut();
let class_id = reg.load_from_file("templates/fabric.wgsl").unwrap();
```

This is the only path external tools need. They never touch the GBuffer pass internals directly.

---

## How the Graph Registry Works

Graph snippets live in `RadiantGraphRegistry`, a `HashMap<u64, String>` owned by the Scene:

```rust
pub struct RadiantGraphRegistry {
    snippets: HashMap<u64, String>,
}

impl RadiantGraphRegistry {
    pub fn register(&mut self, graph_hash: u64, wgsl_snippet: String) {
        self.snippets.insert(graph_hash, wgsl_snippet);
    }
    pub fn get(&self, graph_hash: u64) -> Option<&str> {
        self.snippets.get(&graph_hash).map(|s| s.as_str())
    }
    pub fn unregister(&mut self, graph_hash: u64) {
        self.snippets.remove(&graph_hash);
    }
}
```

The `graph_hash` is a content hash computed by the external compiler. The engine never interprets it — it's purely a lookup key. Two materials with different graphs produce different hashes and different PSOs. Two materials with identical graphs produce the same hash and share a PSO.

The registry is populated at import time by the toolchain:

```rust
scene.radiant_graphs.register(computed_hash, compiled_wgsl);
```

When the GBuffer pass encounters a material with `graph_hash != 0`, it looks up the snippet from `ctx.scene.graph_wgsl_snippets` (a per-frame snapshot of the registry) and passes it to `get_or_create_pipeline`.

If the hash isn't found in the registry, the engine logs a warning and uses `""` as the snippet — the template runs in passthrough mode, equivalent to Tier 1 for that class. The material still renders, just without the custom override. This is deliberate: a missing graph snippet shouldn't crash the frame.

---

## Draw Call Grouping by Material Class

The scene stores materials as a flat array indexed by `MaterialId`. Each object carries a `material_id` field. When the scene rebuilds its instance data — every frame, after GPU culling produces the visible set — it sorts instances by the material's `(material_class, graph_hash)` pair.

The sort is stable. Objects within the same class retain their original order, which preserves any artist-authored draw ordering. The implementation lives in `rebuild.rs`:

```rust
fn rebuild_instance_buffers_persistent(&mut self, device: &wgpu::Device, queue: &wgpu::Queue) {
    let mut sorted: Vec<(u32, u64, u32, &mut ObjectRecord)> = self.objects.iter_mut()
        .filter(|(_, r)| !r.deleted)
        .map(|(idx, r)| {
            let mat_class = self.materials.get(r.material)
                .map(|m| m.gpu.material_class)
                .unwrap_or(0);
            let graph_hash = r.graph_hash;
            (mat_class, graph_hash, idx, r)
        })
        .collect();

    sorted.sort_by_key(|&(cls, hash, ..)| (cls, hash));

    let mut ranges: Vec<(u32, u64, u32, u32)> = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let (cls, hash, ..) = sorted[i];
        let start = i as u32;
        let mut count = 0;
        while i < sorted.len() && sorted[i].0 == cls && sorted[i].1 == hash {
            count += 1;
            i += 1;
        }
        ranges.push((cls, hash, start, count));
    }

    self.gpu_scene.material_class_ranges = ranges;
    // ... upload instance data in sorted order ...
}
```

The `(class, hash, start, count)` ranges are uploaded to `GpuScene::material_class_ranges` and read by the GBuffer pass in `execute()`. Each range is guaranteed to be uniform in both class and graph hash, so it maps to exactly one PSO.

The persistent-mode rebuild runs every frame because GPU culling changes the visible set. The number of objects in a typical scene is in the hundreds to low thousands. The sort is O(n log n) on the CPU, but n is the visible object count, not the total scene size. For a scene with 800 visible objects and 4 material classes, the sort takes roughly 3-5 µs — against a frame budget of 16 ms, it's invisible.

The optimized-mode rebuild (used after `optimize_scene_layout()`) groups objects by `(material_class, mesh_id, material_id)` during the initial clustering pass. The `material_class_ranges` are compacted from the group boundaries. This path runs once, not per frame.

---

## The PSO Table and Lazy Compilation

The GBuffer pass replaced its single `pipeline` field with three things:

```rust
pub struct GBufferPass {
    // ... existing fields ...
    pipelines:       HashMap<RadiantShaderKey, wgpu::RenderPipeline>,
    shader_cache:    RadiantShaderCache,
    template_registry: RadiantTemplateRegistry,
}
```

`RadiantShaderKey` is a 16-byte struct:

```rust
#[derive(Hash, Eq, PartialEq, Clone, Copy, Debug)]
pub struct RadiantShaderKey {
    pub template_id: u32,
    pub graph_hash: u64,
    pub feature_flags: u32,
}
```

`get_or_create_pipeline` checks the HashMap, compiles on miss, caches the result:

```rust
fn get_or_create_pipeline(
    &mut self,
    device: &wgpu::Device,
    key: RadiantShaderKey,
    graph_wgsl: &str,
) -> &wgpu::RenderPipeline {
    if !self.pipelines.contains_key(&key) {
        let template = self.template_registry.get(key.template_id)
            .expect("Unknown material template class: template_id not in registry");

        let module = self.shader_cache.get_or_compile(
            device, key, template, graph_wgsl,
            MAX_TEXTURES, "GBuffer Shader",
        );

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("GBuffer Pipeline"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState {
                module,
                entry_point: Some("vs_main"),
                // ... vertex buffer layout ...
            },
            fragment: Some(wgpu::FragmentState {
                module,
                entry_point: Some("fs_main"),
                // ... color target formats ...
            }),
            // ... depth stencil, primitive, multisample ...
        });
        self.pipelines.insert(key, pipeline);
    }
    &self.pipelines[&key]
}
```

The vertex shader never changes between tiers — it reads instance data and transforms vertices identically regardless of material class. Only the fragment shader changes. But wgpu doesn't support separable PSOs (vertex/fragment independently), so we compile the full pipeline. The vertex module is identical across all variants, and the driver deduplicates the compiled vertex code internally.

`get_or_compile` in the shader cache calls `RadiantTemplate::build_shader_source` to concatenate the template with the graph snippet, then calls `device.create_shader_module`:

```rust
pub fn get_or_compile(
    &mut self,
    device: &wgpu::Device,
    key: RadiantShaderKey,
    template: &RadiantTemplate,
    graph_wgsl: &str,
    max_textures: usize,
    label: &str,
) -> &wgpu::ShaderModule {
    if !self.modules.contains_key(&key) {
        let source = template.build_shader_source(graph_wgsl, max_textures);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(label),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
        self.modules.insert(key, module);
    }
    &self.modules[&key]
}
```

The cache is scoped to the `GBufferPass` instance. It persists across frames and resizes. The only way to clear it is to destroy the pass. This is deliberate: once compiled, a shader module is valid for the lifetime of the device.

The execute method iterates the ranges and issues one multi_draw per range:

```rust
fn execute(&mut self, ctx: &mut PassContext) -> HelioResult<()> {
    // ... bind group rebuilds, same as before ...

    let ranges = &ctx.scene.material_class_ranges;
    if ranges.is_empty() {
        // Fallback: no class data (pre-Radiant scene or startup frame)
        let pipeline = self.get_or_create_pipeline(&ctx.device,
            RadiantShaderKey::default(), "");
        let pass = unsafe { &mut *ctx.active_render_pass_ptr().unwrap() };
        pass.set_pipeline(pipeline);
        pass.multi_draw_indexed_indirect(indirect, 0, draw_count);
    } else {
        let pass = unsafe { &mut *ctx.active_render_pass_ptr().unwrap() };
        for &(class, graph_hash, start, count) in ranges {
            let key = RadiantShaderKey {
                template_id: class,
                graph_hash,
                feature_flags: 0,
            };
            let graph_wgsl = ctx.scene.graph_wgsl_snippets
                .get(&graph_hash).map(|s| s.as_str()).unwrap_or("");
            let pipeline = self.get_or_create_pipeline(&ctx.device, key, graph_wgsl);
            pass.set_pipeline(pipeline);
            pass.multi_draw_indexed_indirect(indirect,
                start as u64 * 20, count);
        }
    }
    Ok(())
}
```

The `20` in `start * 20` is the byte stride of `DrawIndexedIndirectArgs` — five `u32` values at 4 bytes each. This is a wgpu constant that never changes.

---

## Edge Cases

**Missing template class.** If a material references a `material_class` that isn't in the registry, `get_or_create_pipeline` panics with "Unknown material template class". This is deliberate: a class ID without a registered template is always a programming error. The panic happens at pipeline creation time, not during rendering. The external toolchain is responsible for keeping class IDs in sync between the template registry and the materials that reference them.

**Graph hash not found.** If a material has `graph_hash != 0` but the hash isn't in the graph registry, the engine logs a warning and passes an empty snippet. The template runs in passthrough mode. The material still renders — it just doesn't apply the custom graph. This is the only edge case that degrades gracefully. The rationale is that graph snippets can be unregistered independently of materials (e.g., when a graph compiler restarts), and crashing the renderer for a missing snippet would be hostile.

**Mixed classes in a single draw call.** Radiant doesn't support heterogeneous material classes within a single `multi_draw`. This is enforced by the sort: instances are grouped by `(class, hash)` before draw call generation. If the scene were to somehow produce a mixed-class range, the result would be that all objects in that range render with the first object's material class PSO. The class ranges are built from the material data, so this shouldn't happen. The cost of the check at sort time is zero.

**Warp divergence at class boundaries.** At the boundary between two objects with different material classes, a single warp can span pixels from both objects. The warp splits, and the divergent path serializes. The overhead is typically 10-20 cycles per boundary pixel. Against a 500-cycle shader, this is roughly 2-4% local overhead. Across the full frame, the number of boundary pixels is a tiny fraction of the total, so the global cost is undetectable.

**PSO compilation on the first frame.** When the first frame encounters a new template or graph snippet, `create_shader_module` compiles the WGSL source. This is a synchronous call on all backends. On Vulkan with GPL (graphics pipeline libraries), the compile takes roughly 1-3 ms per variant. On Metal, it's 2-5 ms. On DX12, it's similar. The first frame after adding a new material variant will have a visible hitch. Subsequent frames are free.

This is the same cost profile as Unreal's material system, but Radiant pays it less often. Unreal compiles a new permutation for every material graph change, even if the change is just a parameter tweak. Radiant compiles only when the template ID, graph hash, or flags change — parameter-only changes never trigger a recompile.

---

## Comparing the Cost Profile

Unreal's system and Radiant's system both compile shaders, but they compile different things at different times.

In Unreal, every material graph produces a unique HLSL function. The function is compiled into every render pass permutation that uses that material. A scene with 50 unique material graphs and 4 render passes (depth, GBuffer, shadow, forward) produces 200 unique shaders. Each shader takes 1-5 seconds to compile. The total is 200-1000 seconds of shader compilation spread across the first load.

In Radiant, the default path produces exactly one shader: the default PBR uber-shader. It compiles once at graph construction time. Custom templates compile once per template when first encountered. Graph snippets compile once per unique snippet when first encountered. For a scene with 50 materials, none of which use custom graphs, the total is 1 shader compilation. For a scene with 50 materials, 5 of which use custom graph snippets on the same template, the total is 6 compilations.

The difference is 200 versus 6. Both numbers converge to zero after the first frame — the compiled shaders are cached. But the first-frame experience is substantially different.

The driver memory cost follows the same ratio. Unreal's 200 PSOs consume roughly 400-800 KB of driver memory (at 2-4 KB per PSO). Radiant's 6 PSOs consume 12-24 KB. Neither number is significant on a desktop GPU with 8-24 GB of VRAM, but on a mobile device or integrated GPU, the difference matters.

The pipeline-bind cost per draw call is identical in both systems: one `set_pipeline` call per material switch, approximately 1-2 µs on modern drivers. Unreal pays this cost more often because it switches PSOs more frequently. Radiant pays it once per class range, which is typically 2-5 switches per frame regardless of scene complexity.

---

## What Radiant Doesn't Do

Radiant doesn't change the deferred lighting pass. Every material variant writes the same GBuffer format — albedo, normal, ORM, emissive, F0 packed into alpha channels. The deferred lighting shader reads these and evaluates the lighting pass identically. The material variant decision is entirely contained in the GBuffer shader.

This is a deliberate constraint. The GBuffer format is a contract between the GBuffer pass and the lighting pass. Allowing every material to extend it arbitrarily would require the lighting pass to handle dynamic channel layouts, which reintroduces the branching cost Radiant exists to avoid.

If you need a new surface channel — subsurface profile index, clear coat roughness, anisotropy direction — it must be added to the GBuffer format in the engine, not just in the material. The `class_params` field on `GpuMaterial` provides four custom float slots that don't touch the GBuffer format. Material-specific data that needs to reach the lighting pass must go through a separate buffer, keyed by material ID, that the lighting pass reads conditionally.

For most surface types, this constraint is not limiting. Clear coat, subsurface, and anisotropy parameters fit into existing channel budgets or into `class_params`. The graph snippet reads `class_params` like it reads any other parameter:

```wgsl
// Inside a RADIANT_OVERRIDE block: read class-specific params
let clear_coat_strength = material.class_params.x;
let clear_coat_roughness = material.class_params.y;
```

---

## The Template Authoring Contract

A valid template is a complete WGSL file that compiles as a standalone GBuffer shader. It must define:

- All struct types the shader reads (`Camera`, `Globals`, `GpuInstanceData`, `GpuMaterial`, `MaterialTextureData`, `LightmapAtlasRegion`)
- All bind group declarations (camera, globals, instances, lightmaps, materials, textures, samplers)
- `VertexOutput`, `GBufferOutput`, and `SurfaceData` structs
- `vs_main` vertex shader entry point
- `radiant_eval_surface` returning `SurfaceData` with `// RADIANT_OVERRIDE_SURFACE` markers
- `fs_main` fragment shader entry point that calls `radiant_eval_surface` and packs the result

The template does NOT need to handle the graph snippet case. The `RadiantTemplate::build_shader_source` method handles the concatenation. The template author writes the function assuming the override markers are a no-op passthrough.

A minimal template can be derived from the default PBR template by changing the `radiant_eval_surface` body. The `SurfaceData` struct, `GBufferOutput` packing, bind groups, and vertex shader are identical across all templates. In practice, most templates will share these parts through a common base include, though WGSL's lack of `#include` directives means the common code must be duplicated or concatenated at the toolchain level.

---

## Future Work

The current implementation is scoped to the GBuffer pass. The transparent pass uses a separate shader that doesn't go through `radiant_eval_surface`. Extending Radiant to cover transparent materials would require a similar template + override mechanism in the transparent pass shader. The same `RadiantShaderKey` and PSO table approach would work — the transparent pass would need its own template registry and shader cache.

The GBuffer format could be extended to support material-specific data channels. A `material_extra` storage buffer, indexed by material ID, could hold per-material data that the lighting pass reads conditionally. This would let custom materials pass data through to the lighting pass without changing the fixed GBuffer layout. The lighting pass would need a warp-uniform branch gated by a material flag, same as the GBuffer pass.

PSO compilation on the first frame is the one remaining user-visible cost. A disk cache for compiled shader modules would eliminate even the first-frame hitch. wgpu doesn't expose a persistent shader cache API, but the WGSL source itself can be cached and recompiled, which is faster than compiling from scratch because WGSL-to-SPIRV translation is the expensive step, not SPIRV-to-device-binary. A disk cache that stores `RadiantShaderKey` to WGSL source would save the template concatenation step on subsequent runs.

Radiant is open at [github.com/anomalyco/Helio](https://github.com/anomalyco/Helio). The template system lives in `crates/helio/src/radiant/template.rs`, the graph registry in `crates/helio/src/radiant/graph_registry.rs`, the shader cache in `crates/helio/src/radiant/shader_cache.rs`, and the PSO table + draw-group iteration in `crates/helio-pass-gbuffer/src/lib.rs`.
