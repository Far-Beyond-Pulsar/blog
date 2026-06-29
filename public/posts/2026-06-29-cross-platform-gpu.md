---
title: "Cross-Platform GPU Programming Without Losing Your Mind"
date: "2026-06-29"
author: "Tristan Poland"
tags: ["renderer", "wgpu", "rust", "vulkan", "metal", "dx12", "webgpu", "helio", "cross-platform"]
description: "A practical field guide to the platform differences that actually matter when building a GPU renderer on wgpu — bindless limits, indirect draw capabilities, texture format support, and the WGSL footguns that look the same everywhere but behave differently nowhere you expect."
thumbnail: /post_thumb/cross_platform.png
---

## The Promise and the Pain

The pitch sells itself: write your GPU code once in Rust and WGSL, and the same binary runs on Vulkan, DX12, Metal, and WebGPU. That's what wgpu promises, and it delivers — most of the time. The abstraction is genuinely good. Buffer creation, resource binding, pipeline compilation, command recording — all of it maps to the same concepts across every backend with remarkably few surprises.

But "few" is not "none". The gaps between backends are real, and they live in places that wgpu cannot paper over because they're baked into the hardware capabilities themselves. Bindless texture arrays have different maximum sizes on Metal versus Vulkan. Indirect draw with a GPU-side count argument doesn't exist on some backends. Texture format support varies. WGSL itself has subtle differences between the Naga IR that feeds Vulkan and the Metal Shading Language translation path.

This post is a catalog of those gaps. We hit each one during Helio's development, and each one required a different kind of workaround — a `#[cfg]` gate, a runtime feature check, a structural WGSL rewrite, or a fallback path that avoids the missing capability entirely. This isn't a critique of wgpu; it's a map of the terrain. If you're starting a cross-platform GPU project, this is what you'll find on the other side of the abstraction.

---

## What wgpu Actually Gives You

wgpu is not a high-level abstraction that hides the backend. It's a thin, safe API that exposes the same capabilities across Vulkan, DX12, Metal, and WebGPU wherever they overlap. That's a meaningful distinction. You still think in terms of pipelines, bind groups, command encoders, and fences. You still manage resource lifetimes. What wgpu handles for you is the translation — your WGSL shaders get compiled to SPIR-V for Vulkan, DXIL for DX12, and MetalIR for Metal. Your `wgpu::Device` maps to a `VkDevice`, an `ID3D12Device`, or an `id<MTLDevice>` depending on the backend.

The feature set is exposed through `wgpu::Features` — a bitflag enum where each flag corresponds to a capability that may or may not be available on the current backend:

```rust
let adapter_features = adapter.features();
let device_features = device.features();

if adapter_features.contains(wgpu::Features::TIMESTAMP_QUERY) {
    // GPU profiling is available
}
if adapter_features.contains(wgpu::Features::SHADER_PRIMITIVE_INDEX) {
    // SV_PrimitiveID / gl_PrimitiveID is accessible in fragment shaders
}
```

The availability of each feature depends on the backend and the specific hardware. `TIMESTAMP_QUERY` is common on desktop Vulkan and DX12, available on Metal, but silently absent on many WebGPU contexts. `SHADER_PRIMITIVE_INDEX` requires Metal 2.1+ and is not available on some GPU families. Neither of these produces a compile-time error — they produce a runtime `wgpu::RequestDeviceError` if you require them, or silent misbehavior if you use them without checking.

Our rule: always check. Always have a fallback. Never `unwrap()` a device request that includes optional features.

---

## The `#[cfg]` Maze

The most pernicious cross-platform problem in Helio isn't a runtime feature check — it's compile-time constants that differ between backends. Specifically: bindless texture limits.

### Bindless Texture Arrays: 256 vs 16

The textured material system indexes into a bindless texture array in the shader. On Vulkan and DX12, the practical limit is 256 textures in a `texture_2d<f32>` array:

```wgsl
@group(0) @binding(1) var textures: binding_array<texture_2d<f32>, 256>;
```

On Metal and WebGPU, that 256 won't compile. The limit on Metal is 16 for `texture_2d` arrays in a binding array, and on WebGPU the limit is similarly constrained by the maximum sampled textures per shader stage.

The result is a `#[cfg]` nightmare:

```rust
#[cfg(not(any(target_os = "macos", target_arch = "wasm32")))]
pub const MAX_BINDLESS_TEXTURES: u32 = 256;

#[cfg(any(target_os = "macos", target_arch = "wasm32"))]
pub const MAX_BINDLESS_TEXTURES: u32 = 16;
```

But even this isn't right. macOS can run Vulkan via MoltenVK, and on that path the 256 limit applies. `target_os = "macos"` is only correct when wgpu backends through Metal natively. For a wgpu-based renderer, the actual backend selection matters more than the OS — but it's not available at compile time.

The practical workaround: define the WGSL binding at the largest size that Metal supports, and handle the limitation on the Rust side by splitting large texture arrays into multiple bind groups or using a texture atlas. In Helio, we settled on a per-backend constant that maps to the actual queried limits:

```rust
let max_textures = device.limits().max_sampled_textures_per_shader_stage.min(16);
```

And the WGSL shader declares the array at a fixed maximum:

```wgsl
@group(0) @binding(1) var textures: binding_array<texture_2d<f32>, 16>;
```

16 is low, but it works everywhere. For projects that need more, the options are a texture atlas (pack multiple source textures into a single large texture and pass UV offsets per material) or splitting materials across multiple bind groups and switching between them via `set_bind_group()`.

### Sampler Arrays Don't Exist on Metal

Bindless samplers are a separate problem. WGSL supports `binding_array<sampler, 16>` — an array of samplers indexed dynamically. Vulkan and DX12 handle this natively. Metal does not. On the Metal backend, wgpu translates sampler arrays into individual sampler parameters, and the Naga IR path may reject sampler arrays entirely depending on how they're used.

Helio's shaders use a single sampler per bind group. If you need multiple samplers (e.g., point-filtered for shadow maps, bilinear for color textures, anisotropic for normal maps), you declare them as separate bindings rather than a dynamic array:

```wgsl
@group(0) @binding(2) var point_sampler: sampler;
@group(0) @binding(3) var linear_sampler: sampler;
```

This works across all backends. It's slightly more verbose than a sampler array, but it avoids the Metal translation problem entirely.

---

## MULTI_DRAW_INDIRECT_COUNT: Available, Then Not

GPU-driven rendering depends on `multi_draw_indexed_indirect` — the ability to issue a batch of draw calls from a GPU-written buffer with a GPU-written draw count. On Vulkan 1.2+ (`VK_KHR_draw_indirect_count`) and DX12 (tier 2 resource binding), this is standard. On Metal, it does not exist. On WebGPU, it is conditionally available through the `indirect-first-instance` feature.

The difference matters because without a GPU-side draw count, you cannot compact the indirect draw buffer on the GPU without also knowing how many valid draws were emitted. You have two options:

1. **Pre-allocate a fixed number of draws** and always draw that many, padded with degenerate draws that produce zero visible output.
2. **Fall back to individual `draw_indirect` calls** per visible object, relying on the CPU to iterate the draw count.

We use option 1 on backends without `MULTI_DRAW_INDIRECT_COUNT`. The compact shader writes draw commands into a fixed-size indirect buffer, and the draw count is communicated via a separate GPU buffer — but since we can't use that buffer as the count argument, we instead draw the maximum possible count and rely on zero-vertex draws being a no-op:

```rust
#[cfg(feature = "multi_draw_count")]
let count_buf: Option<&wgpu::Buffer> = Some(&self.draw_count_buf);

#[cfg(not(feature = "multi_draw_count"))]
let count_buf: Option<&wgpu::Buffer> = None;

pass.multi_draw_indexed_indirect(
    &self.indirect_buf,
    0,
    self.max_visible_objects as u32,
    count_buf,
);
```

Without `MULTI_DRAW_INDIRECT_COUNT`, every slot in the indirect buffer that contains a degenerate draw (index_count = 0) is still submitted to the driver. We measured this overhead on Metal at roughly 0.2µs per degenerate draw for the first few thousand, climbing to ~0.5µs beyond 10,000. For a scene with 20,000 objects and 12,000 visible, drawing all 20,000 adds about 4ms of driver overhead on Metal that would be free on Vulkan.

The fallback is worth having, but it's not free. If your scene regularly exceeds 5,000 visible objects on Metal, consider a CPU-side compaction pass that reads back the draw count — or restructure to reduce the total draw call count through batching.

---

## WGSL Footguns

WGSL looks portable by design, but the compilation paths introduce backend-specific behaviors that aren't immediately obvious.

### No Returning Arrays from Functions

This is not WGSL-specific, but it catches Rust developers who expect the shader language to support the same patterns:

```wgsl
// Will not compile
fn get_lights(index: u32) -> array<Light, 4> {
    var result: array<Light, 4>;
    // ...
    return result;
}
```

WGSL does not support arrays as return types from functions. The workaround is to pass an output pointer:

```wgsl
fn get_lights(index: u32, result: ptr<function, array<Light, 4>>) {
    // write to (*result)[i]
}
```

Every backend accepts this. The Vulkan SPIR-V path and the Metal IR path both compile it identically.

### No Closures

WGSL has no closures, no function pointers (yet), and no lambdas. Utility patterns that would use a callback in Rust — "apply this function to each element" — must be explicitly inlined or written as helper functions that accept all parameters by value.

### No If-Expressions

WGSL's `if` is a statement, not an expression. You cannot write:

```wgsl
let value = if (cond) { a } else { b };
```

The `select()` intrinsic fills this role:

```wgsl
let value = select(b, a, cond);
```

`select(fallback, value, condition)` returns `value` when `condition` is true, `fallback` otherwise. We use it extensively for conditional field selection, flag-based state resolution, and clamped value computation.

---

## R32Float Filtering: The HiZ Bug

Depth buffer construction for HiZ occlusion culling requires a depth texture that is filterable. R32Float is the natural format — a single 32-bit float per texel, exact depth values, simple to sample.

On Vulkan, `R32Float` is filterable. The Vulkan spec mandates `VK_FORMAT_R32_SFLOAT` support with `VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT` on all implementations. On DX12, Metal, and WebGPU, `R32Float` is NOT filterable. Linear filtering on an R32 texture produces undefined results or a compile error depending on the backend.

This matters for HiZ construction because the mip chain is built by downsampling — bilinear filtering of the previous mip level. If the texture doesn't support filtering, you cannot use `textureSample` with a linear sampler to downsample. You must use `textureLoad` with explicit integer coordinates and write your own averaging logic.

The fix: use `R32Uint` and manually pack four depth values into a `u32`, or use `RGBA16Unorm` and accept the precision loss. Helio uses `R32Uint` for the HiZ buffer and reconstructs depths in the culling shader:

```wgsl
@group(0) @binding(0) var hiz_tex: texture_2d<u32>;

fn load_depth(slot: u32, uv: vec2<u32>) -> f32 {
    let packed = textureLoad(hiz_tex, vec2<i32>(uv), i32(slot));
    return bitcast<f32>(packed);
}
```

The bitcast from `u32` to `f32` is zero-cost on the GPU. The texture load is a single `ld` instruction. This works identically across all backends because `R32Uint` is universally filterable (though in practice we don't filter it — we downsample with explicit compute shader loads).

---

## Depth Format Discrepancies

Depth buffer format selection is a surprisingly rich source of platform differences.

`Depth32Float` is universal. Every backend supports it. It costs 32 bits per texel, it gives you full float precision, and it works everywhere. This is the safe default.

`Depth24Plus` and `Depth24PlusStencil8` are more nuanced. On Vulkan, these map to `VK_FORMAT_D24_UNORM_S8_UINT` or `VK_FORMAT_D32_SFLOAT_S8_UINT` depending on the implementation. On DX12, `D24_UNORM_S8_UINT` is standard. On Metal, `depth24_stencil8` is available only on Apple GPUs (A-series and M-series); on older Intel or AMD GPUs running macOS, it may not exist. WebGPU requires `depth24-plus` support but the actual precision varies by implementation.

The result: if you request `Depth24Plus` or `Depth24PlusStencil8` and your backend doesn't support it, wgpu either fails to create the texture or silently upgrades to `Depth32Float`. The silent upgrade is the dangerous case because it doubles the depth buffer memory cost without warning.

Helio requests `Depth32Float` explicitly in all depth prepass configurations. The memory cost is higher, but the behavior is identical across every backend, every GPU, every driver version. For the stencil variant we use `Depth32FloatStencil8` where available, with a `Depth32Float` fallback for WebGPU contexts that don't support combined depth-stencil at all.

---

## Storage Buffer Alignment

The 16-byte alignment rule for storage buffer structures is consistent across all modern GPU APIs, but it's easy to violate and hard to debug when you do.

Every field in a WGSL struct that maps to a storage buffer must be 16-byte aligned. A `vec3<f32>` is 12 bytes, not 16 — which means a struct field following a `vec3<f32>` may land at a misaligned offset depending on the compiler's padding behavior:

```wgsl
struct BadAlignment {
    a: vec3<f32>,   // offset 0, size 12
    b: f32,         // offset 12 — but should be at offset 16
}
```

WGSL's automatic padding rules are backend-dependent. On the Metal path, Naga may add implicit padding that the DXIL path does not, producing different struct layouts for the same WGSL source.

The fix: explicitly pad to 16-byte boundaries. Every pair of `vec3<f32>` + `f32` becomes a single `vec4<f32>`:

```wgsl
struct CorrectAlignment {
    a: vec4<f32>,   // offset 0, size 16 — xyz = the vec3, w = padding or a packed field
    b: f32,         // offset 16
}
```

In Rust, the corresponding `#[repr(C)]` struct must also be 16-byte aligned. This is handled automatically by the Rust compiler when all fields are 4×f32 or larger, but `bytemuck::Pod` and `Zeroable` derive macros will catch misalignment at compile time if you use them — which you should.

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct CorrectAlignment {
    pub a: [f32; 4],
    pub b: f32,
    _pad: [f32; 3],
}
```

The pad field at the end ensures the struct's total size is a multiple of 16 bytes, which wgpu's validation layer enforces for storage buffers regardless of backend.

---

## TIMESTAMP_QUERY: Silent Absence

GPU timestamp queries are the primary tool for understanding shader performance on real hardware. wgpu exposes them through the `TIMESTAMP_QUERY` feature. On Vulkan and DX12 they're nearly always available (assuming the GPU supports them). On Metal they require `MTLCounterSampleBuffer`, which is available on Metal 2.2+ (macOS 10.15+, iOS 13+). On WebGPU they're optional and many implementations simply don't expose the feature at all.

The problem is silent absence. If you request `TIMESTAMP_QUERY` as a required feature and it's not available, `adapter.request_device()` returns an error. If you request it as an optional feature, the device is created without it, and calling `wgpu::CommandEncoder::write_timestamp()` panics or produces undefined behavior depending on the wgpu version.

The Helio pattern:

```rust
let mut required_features = wgpu::Features::empty();
let mut optional_features = wgpu::Features::TIMESTAMP_QUERY;

let device = adapter.request_device(
    &wgpu::DeviceDescriptor {
        required_features,
        optional_features,
        // ...
    },
    None,
).expect("device creation failed");

let timestamps_available = device.features()
    .contains(wgpu::Features::TIMESTAMP_QUERY);
```

Then conditionally record timestamps:

```rust
if timestamps_available {
    encoder.write_timestamp(&compute_pass, timestamp_query_set, slot_index);
}
```

The `TIMESTAMP_QUERY` feature is marked as optional in `DeviceDescriptor`, so device creation succeeds regardless. The runtime check gates all timestamp operations. When timestamps are unavailable, the profiler falls back to CPU-side timing for that pass.

---

## SHADER_PRIMITIVE_INDEX: Optional for Debug

The `SHADER_PRIMITIVE_INDEX` feature exposes `@builtin(sample_index)` or primitive ID access in fragment shaders. This is useful for debug visualization (highlight individual triangles, wireframe overlay, triangle heatmaps) and for per-primitive data lookups.

On Vulkan and DX12 this is standard via `gl_PrimitiveID` / `SV_PrimitiveID`. On Metal it requires Metal 2.1+ and the `primitive_id` attribute, which is available on Metal-3-capable GPUs and some Metal-2 GPUs via emulation. On WebGPU it's exposed through the `shader-primitive-index` feature, which is optional and not universally supported.

The workaround: the feature is optional in Helio. Debug shaders that require primitive ID are compiled with an alternative entry point when the feature is unavailable:

```rust
let mut required = wgpu::Features::empty();

if device_features.contains(wgpu::Features::SHADER_PRIMITIVE_INDEX) {
    required |= wgpu::Features::SHADER_PRIMITIVE_INDEX;
}

// Create pipeline with optional primitive ID module
let vs_module = &shaders.vs_main;
let fs_module = if required.contains(wgpu::Features::SHADER_PRIMITIVE_INDEX) {
    &shaders.fs_debug_primitive_id
} else {
    &shaders.fs_debug_noop
};
```

When primitive ID is unavailable, the debug visualizations simply don't show triangle-level detail. Everything else works normally.

---

## Storage Buffer Minimum Alignment on the Rust Side

The 16-byte alignment rule has a Rust-side consequence that's easy to miss. When you create a `wgpu::Buffer` with `wgpu::BufferUsages::STORAGE`, the buffer's `size` must be a multiple of 16 bytes, and the `alignment` in `BufferDescriptor` must be at least 16. wgpu enforces this in the validation layer, but the error message is opaque:

```
wgpu error: Buffer size 1232 is not a multiple of COPY_BUFFER_ALIGNMENT (4)
```

The error says "4" but the real constraint is 16 for storage buffers. The confusion comes from the fact that the Vulkan spec requires `minStorageBufferOffsetAlignment` to be at least 16 for `VK_WHOLE_SIZE` storage buffer ranges. The minimum is 16 on all backends.

The fix is to always round storage buffer sizes up to the next multiple of 16:

```rust
pub fn align_storage_size(size: u64) -> u64 {
    const ALIGNMENT: u64 = 16;
    (size + ALIGNMENT - 1) & !(ALIGNMENT - 1)
}
```

And pad any struct that will be written to a storage buffer:

```rust
#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
pub struct StorageItem {
    pub data: [f32; 3],
    _pad:     f32,   // ensures struct size is 16 bytes, not 12
}
```

---

## The Fallback Architecture

All of these platform differences converge into a single architectural pattern in Helio: a feature capability table computed at device creation time.

```rust
pub struct GpuCapabilities {
    pub multi_draw_indirect_count:  bool,
    pub timestamp_queries:          bool,
    pub shader_primitive_index:     bool,
    pub max_textures_per_stage:     u32,
    pub max_storage_buffers:        u32,
    pub indirect_first_instance:    bool,
    pub depth32float_stencil8:      bool,
    pub push_constants:             bool,
    pub subgroups:                  bool,
}
```

Every render subsystem queries this table at initialization and selects between the primary path and a fallback:

```rust
impl GpuCapabilities {
    pub fn from_device(device: &wgpu::Device, adapter: &wgpu::Adapter) -> Self {
        let features = device.features();
        let limits = device.limits();

        Self {
            multi_draw_indirect_count: features
                .contains(wgpu::Features::MULTI_DRAW_INDIRECT_COUNT),
            timestamp_queries: features
                .contains(wgpu::Features::TIMESTAMP_QUERY),
            shader_primitive_index: features
                .contains(wgpu::Features::SHADER_PRIMITIVE_INDEX),
            max_textures_per_stage: limits
                .max_sampled_textures_per_shader_stage,
            max_storage_buffers: limits
                .max_storage_buffers_per_shader_stage,
            indirect_first_instance: features
                .contains(wgpu::Features::INDIRECT_FIRST_INSTANCE),
            depth32float_stencil8: features
                .contains(wgpu::Features::DEPTH32FLOAT_STENCIL8),
            push_constants: features
                .contains(wgpu::Features::PUSH_CONSTANTS),
            subgroups: features
                .contains(wgpu::Features::SUBGROUPS),
        }
    }
}
```

Each pass receives a reference to the capability table and dispatches accordingly. The fallback paths are not afterthoughts — they are compiled, tested, and maintained alongside the primary paths. This adds surface area to every subsystem that touches a platform-dependent feature, but it means the renderer never silently breaks on an unsupported backend.

---

## What We'd Tell Ourselves

Building a cross-platform GPU renderer is feasible with wgpu. The abstraction is good, the API is safe, and the portability is real — we ship on Vulkan, DX12, Metal, and WebGPU from the same codebase. But the abstraction has seams, and knowing where they are before you start matters more than it seems.

A few concrete takeaways:

**Check every optional feature at runtime.** Do not assume any feature above the base wgpu feature set is available. `TIMESTAMP_QUERY`, `SHADER_PRIMITIVE_INDEX`, `MULTI_DRAW_INDIRECT_COUNT`, `PUSH_CONSTANTS`, `DEPTH32FLOAT_STENCIL8` — all of them can be absent. Build your capability table on startup and route through it consistently.

**Never trust implicit padding.** WGSL struct layout is backend-dependent when fields aren't explicitly 16-byte aligned. `vec3<f32>` followed by `f32` is a hazard. Use `vec4<f32>` for every storage buffer field group and explicitly pad on the Rust side to match.

**Texture format support is not uniform.** `R32Float` is filterable on Vulkan but not on Metal/DX12/WebGPU. `Depth24Plus` has variable availability. Always query texture format features and have a fallback format ready.

**Bindless limits are real.** 16 textures per shader stage on Metal and WebGPU. If your material system needs more than that, the texture atlas approach is simpler than splitting bind groups at runtime — and it avoids the WGSL `binding_array` size mismatch across backends.

**WGSL is the language, but the compiler matters.** Naga's Metal backend translates WGSL to Metal Shading Language, and the translation path has edge cases — sampler arrays, function pointer types, and some WGSL intrinsic overloads. Test on Metal early. The differences are rarely visible on Vulkan.

**The fallback path is the real product.** The code that runs when `MULTI_DRAW_INDIRECT_COUNT` is absent, or when texture arrays are limited to 16, or when timestamp queries are unavailable — that code is what determines whether your renderer actually runs on the target platform. Invest in it proportionally to the primary path.

Helio is open at [github.com/Far-Beyond-Pulsar/Helio](https://github.com/Far-Beyond-Pulsar/Helio). The platform capability table, the multi_draw fallback, the HiZ texture rework, and the alignment utilities are all in the source.
