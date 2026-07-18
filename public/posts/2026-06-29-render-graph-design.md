---
title: "Designing a Render Graph That Doesn't Get in the Way"
date: "2026-06-29"
author: ["tristanpoland"]
tags: ["rust", "helio", "graphics", "architecture", "pulsar"]
description: "A detailed walkthrough of Helio's render graph — how passes declare resource dependencies, the lazy bind-group rebuild pattern, subpass chaining for framebuffer compression, and why we chose typed passes over a JSON graph."
thumbnail: /post_thumb/render_graph.png
---

## Why a Render Graph

The word "render graph" means different things in different projects. In Frostbite's architecture it's a data-driven DAG of GPU work items serialized from a JSON file at boot. In The Forge it's a C++ macro-heavy framework that generates bindings at compile time. Granite's render graph owns the texture lifetime management and aliases non-overlapping resources to keep VRAM flat. They all solve a version of the same problem: as the number of render passes grows, manually managing texture lifetimes, resource transitions, and pass ordering becomes the dominant source of bugs and the thing that makes adding a new feature harder than it should be.

Helio's render graph evolved rather than being designed upfront. The first version had no graph at all — just a hardcoded sequence of function calls in a `render()` method. Adding a pass meant adding a function call in the right place, ensuring the texture it reads was written by a previous call, and hoping nobody reordered them in a refactor. That worked for six passes. It stopped working around twelve, when we started wanting optional passes (TAA, SSAO, Hi-Z construction) that could be inserted or removed without editing the central render function.

This post is an honest account of what we built and why it looks the way it does. It covers the `RenderPass` trait, the two-phase prepare/execute lifecycle, the lazy bind-group rebuild pattern that GrowableBuffers forced on us, the `Tracked<T>` cross-pass resource contract, resource pooling and aliasing, subpass chaining, and what I'd change if I were starting over.

---

## Typed Passes Over JSON Graphs

The first design question is what a pass *is*. The data-driven approach — declare passes and their attachments in JSON, parse at boot, build pipelines — has a clean surface. You can render your graph visually, serialize it, and change it without recompiling. Frostbite's graph is the canonical example of this model and it works well at their scale.

We chose typed passes anyway. Every pass is a Rust struct implementing `RenderPass`, compiled into the binary. The graph is assembled by calling `graph.add_pass()` with concrete pass instances:

```rust
graph.add_pass(Box::new(ShadowPass::new(&device, &queue, &camera_buf, surface_format)));
graph.add_pass(Box::new(ShadowCullPass::new(&device)));
graph.add_pass(Box::new(GBufferPass::new(&device, &queue, &camera_buf, surface_format)));
graph.add_pass(Box::new(DeferredLightingPass::new(&device, surface_format)));
graph.add_pass(Box::new(FxaaPass::new(&device, surface_format)));
```

There are several reasons for this choice, none of which is "Rust makes JSON parsing painful" (it doesn't). The real reasons are:

First, GPU pipeline objects in wgpu are created from shader modules and layout descriptors that are intrinsically tied to Rust types. A JSON graph would need to either encode the full pipeline state (and be re-parsed every boot) or reference pre-compiled pipelines by name — at which point the JSON is just indirection over a typed API with no real advantage.

Second, passes carry mutable state. The Corona particle pass holds a CPU-side emitter cursor mirror and a rebuildable sort-step buffer. The GBuffer pass tracks material texture versioning. The Hi-Z pass owns the previous-frame depth. Encoding that state through a JSON graph would require a plugin interface or dynamic dispatch at every access. We have dynamic dispatch at the `Box<dyn RenderPass>` boundary once, not per-resource-access.

Third, type-safe downcasting matters. The high-level renderer frequently needs to reach into a specific pass to configure it:

```rust
let corona = graph.find_pass_mut::<CoronaPass>().unwrap();
corona.depth_sort_enabled = scene.settings.particle_sorting;
```

This is O(1) — a `TypeId` hash lookup in the pass index map — and requires no string matching or enum dispatch. The `find_pass_mut<T>()` call is an exact type check at compile time. If the pass isn't registered, it's a `None` handled at the call site, not a runtime parse error.

The cost of typed passes is that adding a new pass requires a new crate and a recompile. For us that cost is negligible. For a project with externally authored passes and a plugin ecosystem, the JSON approach would be the right call. Our passes are all written in-tree by the same two people.

---

## The RenderPass Trait

Every pass implements a single trait:

```rust
pub trait RenderPass: AsAny + MaybeSend + MaybeSync {
    fn name(&self) -> &'static str;

    fn reads(&self) -> &'static [&'static str] { &[] }
    fn writes(&self) -> &'static [&'static str] { &[] }

    fn declare_resources(&self, builder: &mut ResourceBuilder) {}

    fn prepare(&mut self, ctx: &PrepareContext) -> Result<()> { Ok(()) }
    fn execute(&mut self, ctx: &mut PassContext) -> Result<()>;

    fn publish<'a>(&'a self, frame: &mut FrameResources<'a>) {}
}
```

The lifecycle is: `declare_resources()` is called once at graph construction to collect inter-pass texture dependencies. Then every frame the graph iterates passes in registration order, calling `prepare()` then `execute()` on each.

The two-phase split exists because wgpu's `Queue::write_buffer()` needs a `&Queue` reference available in `prepare()`, while `CommandEncoder::begin_render_pass()` needs `&mut CommandEncoder` access during `execute()`. These must be separate calls because they borrow different global resources — the queue is shared across all passes for CPU→GPU uploads, and the encoder is exclusive per-frame. The graph constructs both contexts from the same per-frame data and hands each pass what it needs.

---

## PassContext vs PrepareContext

`PrepareContext` passes a `&GpuScene` — the full scene's GPU state, including all buffer manager handles. The GBuffer pass uses it to write globals uniforms and check material texture versioning. Corona uses it to read emitter frame data and rebuild sort steps. The key point is that `PrepareContext::scene` is `&GpuScene` — it can read buffer manager versions, camera uniforms, and material state, but it can't start render passes.

`PassContext` passes `SceneResources<'a>` — a flat struct of `&wgpu::Buffer` references extracted from the scene managers at flush time:

```rust
pub struct SceneResources<'a> {
    pub camera:           &'a wgpu::Buffer,
    pub instances:        &'a wgpu::Buffer,
    pub aabbs:            &'a wgpu::Buffer,
    pub draw_calls:       &'a wgpu::Buffer,
    pub lights:           &'a wgpu::Buffer,
    pub materials:        &'a wgpu::Buffer,
    pub shadow_matrices:  &'a wgpu::Buffer,
    pub indirect:         &'a wgpu::Buffer,
    pub visibility:       &'a wgpu::Buffer,
    pub draw_count:       u32,
    pub light_count:      u32,
    pub shadow_count:     u32,
}
```

The split exists because `execute()` runs after `scene.flush()` — any GrowableBuffer that needed to reallocate has already done so by the time `execute()` runs. The raw buffer pointers in `SceneResources` are valid for the duration of the frame. Passes that cache bind groups keyed on these pointers (the lazy rebuild pattern) check identity by pointer equality in `execute()`, not in `prepare()`.

---

## The Lazy Bind-Group Rebuild Pattern

GrowableBuffer is a core Helio abstraction: a CPU-mirrored `Vec<T>` backed by a `wgpu::Buffer` that doubles its GPU allocation when the CPU side outgrows it. The reallocation replaces the old buffer with a new one at twice the capacity. This is invisible to the CPU upload path but invalidates every bind group that references the old buffer.

A bind group in wgpu holds strong references to the buffers it binds. Creating a new bind group is a device call that involves the borrow checker trampoline and a pipeline-layout validation. It's not free, but it's far cheaper than pre-allocating all scene buffers at maximum capacity.

The solution is the `bind_group_key` pattern: each pass caches its bind group alongside a tuple of raw buffer pointers. On every `execute()` call, the pass recomputes the key from the current `SceneResources` and only rebuilds the bind group when the key changes:

```rust
fn execute(&mut self, ctx: &mut PassContext) -> HelioResult<()> {
    let camera_ptr   = ctx.scene.camera    as *const _ as usize;
    let instances_ptr = ctx.scene.instances as *const _ as usize;
    let key = (camera_ptr, instances_ptr);

    if self.bind_group_key != Some(key) {
        self.bind_group = Some(ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("GBuffer BG 0"),
            layout: &self.bind_group_layout_0,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: ctx.scene.camera.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.globals_buf.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: ctx.scene.instances.as_entire_binding() },
            ],
        }));
        self.bind_group_key = Some(key);
    }

    let bg = self.bind_group.as_ref().unwrap();
    let mut rp = ctx.begin_render_pass(&wgpu::RenderPassDescriptor { ... });
    rp.set_bind_group(0, bg, &[]);
    ...
}
```

At steady state — when no GrowableBuffer has reallocated — the key check is a tuple comparison of two `usize` values. No allocation, no device call, no pipeline layout validation. The bind group created on frame 1 is reused for frames 2 through N until an instance count spike triggers a reallocation.

A subtlety worth calling out: the key must include **every** buffer pointer the bind group references. If the pass binds both `ctx.scene.instances` and `ctx.scene.lights`, and the key only tracks `instances`, a light buffer reallocation silently produces a stale bind group that points to the old light buffer. The GPU still uses the old data. Tracking the full set of pointers is mechanical but easy to forget during refactoring. We've fixed this bug three times in three different passes.

---

## Resource Declaration

The `declare_resources()` method lets the graph know which inter-pass textures each pass reads and writes. The graph uses these declarations to create and own all transient textures, routing views into `FrameResources` automatically:

```rust
fn declare_resources(&self, builder: &mut ResourceBuilder) {
    builder.read("pre_aa");
    builder.read("full_res_depth");
    builder.read("shadow_atlas");
    builder.read("depth");
    builder.write_color("gbuffer_albedo", ResourceFormat::Rgba8Unorm, ResourceSize::MatchSurface);
    builder.write_color("gbuffer_normal", ResourceFormat::Rgba16Float, ResourceSize::MatchSurface);
    builder.write_color("gbuffer_orm", ResourceFormat::Rgba8Unorm, ResourceSize::MatchSurface);
    builder.write_color("gbuffer_emissive", ResourceFormat::Rgba16Float, ResourceSize::MatchSurface);
}
```

The graph allocates each texture once and tracks its lifetime — the pass range from first writer to last reader. Non-overlapping textures in the same alias group can share a single `wgpu::Texture` allocation. The SSAO output and the Hi-Z input don't overlap temporally, so they alias the same backing store:

```rust
// SSAOPass writes ssao, HiZPass reads it.
// They don't run concurrently, so the graph aliases their memory.
builder.write_color("ssao", ResourceFormat::R8Unorm, ResourceSize::MatchSurface);
```

The alias group system is a simple string tag. Resources with the same alias group name share a single allocation when their lifetimes don't overlap. The graph uses a greedy interval packing algorithm: sort by first-writer pass, allocate into the first alias group slot that's free at that point.

Textures are created lazily — the first call to `set_render_size()` allocates the pool. On resize, the pool is cleared and all textures are re-created at the new resolution. Texture views are created at allocation time and stored in the pool; passes receive borrowed references through `FrameResources`. The route from pool → `FrameResources` happens automatically before each pass via the `PrePassAction` system:

```rust
match name {
    "pre_aa"   => frame.pre_aa.write(view, "Graph"),
    "ssao"     => frame.ssao.write(view, "Graph"),
    "hiz"      => frame.hiz.write(view, "Graph"),
    "sky_lut"  => frame.sky_lut.write(view, "Graph"),
    ...
}
```

This is the part of the graph I'm least happy with — the routing is a hardcoded match statement. Adding a new named resource means adding an arm. A dynamic routing table keyed by resource name would be better, but the number of inter-pass textures hasn't changed much (around fifteen), so the pain has never risen past mild annoyance.

---

## The FrameResources / Tracked&lt;T&gt; Pattern

Passes communicate data to downstream passes through `FrameResources<'a>`. This is a flat struct of all possible inter-pass data — texture views, buffer references, sampler handles, and scene metadata:

```rust
pub struct FrameResources<'a> {
    pub gbuffer:             Tracked<GBufferViews<'a>>,
    pub shadow_atlas:        Tracked<&'a wgpu::TextureView>,
    pub hiz:                 Tracked<&'a wgpu::TextureView>,
    pub sky_lut:             Tracked<&'a wgpu::TextureView>,
    pub ssao:                Tracked<&'a wgpu::TextureView>,
    pub pre_aa:              Tracked<&'a wgpu::TextureView>,
    pub main_scene:          Tracked<MainSceneResources<'a>>,
    pub billboards:          Tracked<BillboardFrameData<'a>>,
    pub corona_emitters:     Tracked<CoronaEmitterFrameData<'a>>,
    ...
}
```

Every slot is `Tracked<T>`. In release builds it compiles down to `Option<T>`. In debug builds it additionally tracks which pass wrote the value:

```rust
pub struct Tracked<T> {
    value: Option<T>,
    #[cfg(debug_assertions)]
    written_by: Option<&'static str>,
}

impl<T: Copy> Tracked<T> {
    pub fn write(&mut self, value: T, pass_name: &'static str) { ... }
    pub fn read(&self, reader_pass: &'static str) -> Option<T> { ... }
}
```

The `read()` call panics in debug builds if the slot was never written by a prior pass this frame. This catches a surprisingly common class of bugs: a pass declares it reads "ssao" but the SSAO pass was removed or reordered, and the slot is empty when the reading pass executes. Without tracking, you'd get a `None.unwrap()` crash somewhere in the pass — or worse, a null view reference propagating into a render pass descriptor, which wgpu catches as a validation error with a confusing message about attachment mismatches.

The tracking has a one-frame grace period: `reset_tracking()` re-marks all populated slots at the start of each frame so that a slot written on frame N doesn't satisfy the "was written this frame" check on frame N+1. Without this, a pass that writes every other frame would appear to be always available after the first write.

---

## The Bug We Keep Fixing

The Tracked pattern catches one specific issue well but misses another: a pass writing the *wrong* resource to a slot. Consider the scenario where the Hi-Z pass writes `hiz` but accidentally routes a shadow atlas view into the slot. The slot is written — tracking thinks everything is fine — and the occlusion cull pass reads a depth texture that's actually a shadow map. The result is garbage occlusion queries that pass everything, which manifests as a scene that renders correctly but runs slowly because no occlusion culling is happening.

We used to chase this as a performance regression for three weeks before noticing the Hi-Z build pass had a routing mistake introduced in a refactor. The root cause was that the routing map (the large `match` statement in the graph executor) and the pass's `publish()` method both needed to agree on which name maps to which slot. When they diverged, tracking still reported success because the slot was technically written.

The fix was a unit test that walks every pass, calls `publish()` into a `FrameResources`, and asserts that every slot written by a pass matches the expected type signature. It's a compile-time check on the test side but catches runtime routing mismatches before they reach a real frame.

---

## Resource Pooling and Lazy Texture View Creation

Inter-pass textures are created eagerly at resize and persist until the next resize event. The pool owns the textures and their views. When a pass needs to write to "ssao", the view is already in the pool — no allocation on the render path.

The tradeoff is that every texture declared by any pass lives for the entire render session. For fifteen textures at internal resolution (typically 1920×1080 or lower with render scaling), this is about 150–200 MB depending on formats. The alternative — create-on-first-write and destroy-on-last-read — would save VRAM at the cost of allocation churn on every size change and more complex lifetime tracking.

We chose eager allocation because it's simple and the VRAM cost is acceptable. The total pool is smaller than the asset textures loaded for a single scene.

Texture views are created once per pool allocation. The `create_view()` call on most wgpu backends is not free — it allocates driver resources and may trigger a deferred command buffer flush. Eager allocation means we pay this cost once at resize rather than every frame.

The one exception is depth-stencil views. The depth buffer is shared between the depth prepass, the GBuffer pass, and the deferred lighting pass. Rather than passing the raw texture and having each pass create its own view, the pool creates a single depth view and routes it to all passes that need it. This avoids redundant `create_view()` calls and ensures all passes agree on the view descriptor (format, mip level, array layer).

---

## Subpass Chaining

Modern tile-based GPU architectures (PowerVR, Qualcomm Adreno, Apple GPUs) benefit significantly from subpasses — the ability to run multiple rendering stages within a single render pass, keeping intermediate framebuffer data in on-chip tile memory rather than writing it to system memory and reading it back.

The graph detects fusible chains automatically using a greedy forward scan. Pass A and pass B can be fused if B's `reads()` contains any resource that A's `writes()` contains:

```rust
fn detect_subpass_chains(&mut self) {
    let mut i = 0;
    while i < self.passes.len() {
        let chain_start = i;
        while i + 1 < self.passes.len() {
            let writes_i = self.passes[i].writes();
            let reads_next = self.passes[i + 1].reads();
            let can_fuse = writes_i.iter().any(|w| reads_next.contains(w));
            if !can_fuse { break; }
            i += 1;
        }
        if (i + 1 - chain_start) >= 2 {
            self.subpass_chains.push(chain_start..i + 1);
        }
        i += 1;
    }
}
```

The GBuffer → DeferredLighting chain is the classic example on tile-based hardware. The GBuffer writes four color targets and depth. DeferredLighting reads all four and writes a single shaded output. With subpass chaining, the tile memory holds the G-buffer values between the two passes — no VRAM round-trip. The bandwidth saving is proportional to the total G-buffer size, which at 1080p with four targets is roughly 32 MB per frame saved.

The detection runs once at init and is exposed in the debug overlay:

```
chain 0: GBufferPass → DeferredLightingPass
chain 1: SSAOPass → HiZBuildPass
```

The actual fusion — opening one render pass and calling `next_subpass()` between passes — is partially implemented. The graph opens the render pass and hands each pass a `&mut RenderPass` through `ctx.active_render_pass` instead of having each pass call `begin_render_pass()` itself. Each pass records its draw calls into the shared pass and returns. The graph calls `end_render_pass()` after the last pass in the chain.

The complication is that not all passes can participate. A pass that needs to bind a compute pipeline or write to a buffer halfway through a chain can't run as a subpass. The graph handles this by detecting the non-fusible pass and ending the chain before it, starting a new chain after.

---

## The PerfOverlayAnalyzerPass Pattern

One pattern that emerged organically and turned out to be generally useful is the wrapper pass. The `PerfOverlayAnalyzerPass` isn't a real pass — it's a pass wrapper that instruments every other pass automatically:

```rust
pub struct PerfOverlayAnalyzerPass {
    inner: Box<dyn RenderPass>,
    depth_compare_pipeline: wgpu::ComputePipeline,
    ...
}
```

It delegates `prepare()` and `execute()` to the inner pass, but wraps `execute()` with pre- and post-dispatch compute shaders that sample the depth buffer and color targets between each pass invocation. The pre-pass sample reads the current depth; the post-pass reads it again. Pixels whose depth changed between the two reads identify which pixels were touched by the wrapped pass, producing an overdraw heatmap.

The wrapper implements `RenderPass` directly, so it can be used anywhere a plain pass is expected:

```rust
graph.add_pass(Box::new(PerfOverlayAnalyzerPass::new(
    Box::new(GBufferPass::new(&device, &queue, &camera_buf, surface_format)),
    PerfOverlayMode::PassOverdraw,
)));
```

This is how we get per-pass overdraw visualization without any per-pass instrumentation. Every pass is automatically wrapped at graph construction time when the perf overlay is enabled. The overlay mode is toggled at runtime with no pass code changes.

The cost is one compute dispatch before and after the wrapped pass, each sampling the depth and color buffers. On desktop GPUs the cost is negligible (sub-0.1ms). On mobile it may be more significant, which is why the overlay defaults to `Disabled`.

---

## What We'd Change If We Redesigned Today

**The routing table.** The hardcoded match statement that routes pool textures into `FrameResources` slots is the ugliest part of the graph. A dynamic system where each resource declaration specifies its `FrameResources` field path would eliminate the routing function entirely. Instead of `builder.write_color("ssao", ...)` and a separate match arm, the builder would take `frame.ssao` as a slot reference directly. Rust's type system makes this awkward to express with references through mutable borrows, but a proc-macro generating the routing table from `FrameResources` field annotations would be cleaner.

**Subpass fusion for real.** The current subpass detection produces accurate chains, but the actual execution still opens separate render passes for each chain. The graph knows which passes can fuse but doesn't exploit it to the point of keeping tile memory resident across the chain boundary. The missing infrastructure is that each pass needs to produce its render pass descriptor in a way the graph can compose: the graph opens the parent render pass, then for each subpass calls `next_subpass()` and lets the child pass record its draws. The `render_pass_descriptor()` method was the first step toward this, but the graph doesn't yet call `next_subpass()` between descriptors.

**Cross-frame resource aliasing.** The pool allocates textures at resize and holds them until the next resize. Some resources are only needed every other frame — the sky LUT is rebuilt only when sky parameters change, which may be never after initialization. A generation counter on each resource declaration would let the pool free textures that haven't been written for N frames and reallocate them on demand. This matters less on desktop (150 MB pool is fine) and more on the wasm target where GPU memory pressure is tighter.

**Error recovery.** If a pass fails during `execute()`, the graph currently propagates the error and skips the remaining passes. The encoder is in an undefined state. Recovering from a GPU error mid-frame requires either resetting the encoder and re-recording from a known-good pass, or abandoning the frame entirely and presenting the previous frame's output. Neither is implemented. If we were designing for a shipped product with crash recovery requirements, we'd build frame-level rollback into the graph from the start.

---

## What's Next

The graph needs the subpass fusion completed — the infrastructure is there, the detection is correct, but the execution path still opens individual render passes. That's the single change with the most potential bandwidth savings for our mobile and WebGPU targets.

We also want to expose the graph resource view as a debugging overlay. The `collect_frame_debug_data()` method already exports the resource table, pass chain, and alias group information. The overlay pass renders this as an interactive minimap showing which textures are alive at each pass index and where aliasing is happening.

The graph currently has no concept of frame graph optimization — reordering passes for better cache behavior or merging independent compute dispatches. The pass order is the registration order. An optimization pass that reorders independent compute passes to reduce encoder overhead would benefit the Corona sort pipeline (currently ~220 dispatches per frame when depth sorting is enabled). This is speculative; the immediate bottleneck is dispatch overhead, not cache behavior, and the dispatch overhead fix is to collapse multiple sort stages into fewer dispatches rather than reordering them.

Helio is open at [github.com/Far-Beyond-Pulsar/Helio](https://github.com/Far-Beyond-Pulsar/Helio). The graph code lives in `crates/helio-v3/src/graph/`. If this architecture looks like something you'd approach differently, we'd genuinely like to hear about it.
