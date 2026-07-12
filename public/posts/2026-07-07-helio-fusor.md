---
title: "Helio Fusor: How the Executor Took Ownership of the Render Pass and Why Nobody Noticed"
date: "2026-07-07"
author: "Tristan Poland"
tags: ["rust", "helio", "graphics", "architecture", "pulsar"]
description: "How Helio's Fusor system fuses adjacent render passes into a single GPU render pass — why the executor, not the passes, owns the render pass lifecycle, how passes write to a pointer they don't own, and what this saves on Vulkan, Metal, DX12, and WebGPU."
thumbnail: /post_thumb/fusor.png
---

## The Problem With Intermediate Textures

Render graphs solve pass ordering and resource lifetime management. But they introduce a new problem: every time pass A writes a texture that pass B reads, that texture is stored in VRAM. On a tile-based GPU — every Apple Silicon chip, every Qualcomm Adreno, every PowerVR, every ARM Mali — this round-trip is catastrophic for bandwidth. The tile memory contains the data pass A wrote. Instead of passing it directly to pass B's fragment shader, the GPU writes it out to system memory, reads it back, and the bandwidth that could have been used for shading is wasted on unnecessary load-store cycles.

Helio's render graph, described in a [previous post](/2026-06-29-render-graph-design), already handled resource declaration, lazy bind-group rebuilds, and texture pooling. But the graph originally ran every pass as a standalone `wgpu::RenderPass` — open, draw, close, repeat. Each pass owned its own render pass. The intermediate textures existed as real GPU allocations with real contents written, stored, and read back.

The **Fusor** is the system that detects when adjacent passes can be collapsed into a single render pass. When it works, intermediate data stays in tile memory — or, on an immediate-mode GPU, in on-chip L2 cache — and never touches VRAM. The bandwidth saving on tile-based architectures is proportional to the size of the intermediate attachments. For a GBuffer chain at 1080p with four color targets, that's roughly 32 MB per frame that never hits memory.

But the Fusor isn't *just* a chain detection algorithm. It's an inversion of ownership. Before the Fusor, each pass crate opened its own render pass, recorded its draws, and closed it. The executor sequenced those passes but had no control over the render pass lifecycle. The Fusor moved that responsibility into the executor. Passes no longer own their render pass — they draw into whatever render pass the executor gives them, whether it's standalone, fused as part of a chain, or shared with other passes. The pass doesn't know and doesn't need to know.

This post covers the Fusor's chain detection, the ownership inversion that makes it work, how passes interact with the executor through a pointer to an opaque render pass they don't control, the `chain_transparent` optimization, and the backend-specific behavior across Vulkan, Metal, DX12, and WebGPU.

---

## What the Fusor Actually Is

The Fusor has two parts: a detection phase and an execution phase. The detection phase is what most people think of when they hear "subpass fusion" — the algorithm that finds adjacent passes that can share a render pass. The execution phase is the less visible but more impactful part: the executor takes ownership of the `wgpu::RenderPass` lifecycle and hands each pass a pointer to draw into.

Before the Fusor, every pass's `execute()` method looked roughly like this:

```rust
fn execute(&mut self, ctx: &mut PassContext) -> Result<()> {
    let mut rp = ctx.begin_render_pass(/* ... */);
    rp.set_pipeline(&self.pipeline);
    rp.set_bind_group(0, &self.bind_group, &[]);
    rp.draw_indexed(0..self.index_count, 0, 0..1);
    Ok(())
}
```

The pass called `begin_render_pass`, recorded draws, and the render pass was dropped (closed) at the end of the scope. Each pass owned its render pass from open to close. The executor sat between passes, submitting command buffers, but had no influence on the render pass boundaries.

After the Fusor, the same pass looks like this:

```rust
fn execute(&mut self, ctx: &mut PassContext) -> Result<()> {
    let rp = unsafe { &mut *ctx.active_render_pass_ptr() };
    rp.set_pipeline(&self.pipeline);
    rp.set_bind_group(0, &self.bind_group, &[]);
    rp.draw_indexed(0..self.index_count, 0, 0..1);
    Ok(())
}
```

The pass no longer opens or closes a render pass. It receives a pointer to whatever render pass the executor has open — which could be a standalone pass just for this pass, or a chain-shared pass shared with the previous and next passes. The pass doesn't know which case it is. It doesn't need to.

The pointer indirection is the key. `ctx.active_render_pass_ptr()` returns a `*mut wgpu::RenderPass<'static>` that the executor sets before calling `execute()`. For passes in a chain, the pointer points to the chain's `ManuallyDrop<wgpu::RenderPass>`. For standalone passes, it points to a freshly opened render pass that will be closed after `execute()` returns. For compute-only passes, it's `None` and the pass uses the compute encoder instead.

The pass crate doesn't import the Fusor. It doesn't check whether it's in a chain. It just draws into the pointer. The Fusor is entirely in the executor — the pass doesn't know it exists.

---

## How Passes Opt Out of Render Pass Management

The `RenderPass` trait has a method that makes all of this possible:

```rust
fn render_pass_descriptor<'a>(
    &'a self,
    target: &'a wgpu::TextureView,
    depth: &'a wgpu::TextureView,
    resources: &'a libhelio::FrameResources<'a>,
) -> Option<wgpu::RenderPassDescriptor<'a>>;
```

Every pass implements this. It returns the descriptor for the render pass it *would* open if it were managing its own lifecycle — the color attachments, depth attachment, timestamp queries, and occlusion query set. But the pass never uses this descriptor directly. It returns it to the executor, and the executor decides what to do with it.

For passes that return `None` (compute-only passes like culling, sorting, or Hi-Z construction), the executor routes them to the compute encoder. For passes that return `Some(desc)`, the executor either:

- Opens a standalone render pass from `desc`, hands the pass a pointer to it, closes it after.
- Opens a chain render pass from the first pass's `desc`, hands each pass in the chain a pointer to it, closes it after the last pass.

The pass never calls `begin_render_pass` or `end_render_pass`. It declares what it needs through `render_pass_descriptor`, and the executor makes the lifecycle decision. This separation is what lets the Fusor exist without any pass crate changes.

The comment in `traits.rs` puts it directly:

```rust
/// Every pass **must** implement this — there is no default. Compute-only
/// passes return `None`; render passes return `Some(descriptor)` so the
/// executor can manage the render pass lifecycle (subpass chaining,
/// store-op patching, tile-memory fusion).
```

"Tile-memory fusion" is the Fusor. The pass declares its attachments, the executor decides whether to fuse.

---

## The Chain Detection Algorithm

The core detection is a greedy forward scan in `compute_chains()` (`scheduling.rs:57`). It iterates the pass list and, for each pass that has a `render_pass_descriptor()` returning `Some`, looks ahead to see if the next pass can be fused into it.

Two passes fuse when three conditions hold:

1. **Data dependency**: `writes[i]` intersects `reads[j]`. Pass A must produce something pass B consumes.

2. **Identical attachments**: Both passes target the exact same set of texture views. This is the condition that surprises people. It's not enough that pass B *reads* the output of pass A as a texture input — it must also be rendering to the *same* physical attachments. The GBuffer pass writes to `gbuffer_albedo`, `gbuffer_normal`, `gbuffer_orm`, and `gbuffer_emissive`. The deferred lighting pass reads those textures but renders to `pre_aa`. They cannot fuse because their attachment sets differ. The chain that actually forms in Helio's frame graph is `BillboardPass → CoronaPass`, both drawing (with `LoadOp::Load`) into `pre_aa`.

3. **Both return `Some` from `render_pass_descriptor()`**: Compute-only passes cannot open or join a chain. They return `None`, and the scanner skips them.

The detection runs at lock time — once, when the graph is finalized — not per frame. `RenderGraph::lock()` creates dummy 1×1 textures, calls `render_pass_descriptor()` on every pass to probe its attachment signature, then runs `detect_subpass_chains_probed()` with the real signatures.

The implementation is a pure function with no GPU dependency, tested with a suite of unit tests:

```rust
fn compute_chains(
    writes: &[Vec<&str>],
    reads: &[Vec<&str>],
    transparent: &[bool],
    attachments: &[Option<Vec<usize>>],
) -> Vec<Range<usize>> {
    let len = writes.len();
    let mut chains = Vec::new();
    let mut i = 0;
    while i < len {
        if attachments[i].is_none() {
            i += 1;
            continue;
        }
        let chain_start = i;
        loop {
            let mut j = i + 1;
            while j < len && transparent[j] { j += 1; }
            if j >= len { break; }
            let same_attachments = match (&attachments[i], &attachments[j]) {
                (Some(a), Some(b)) => a == b,
                _ => false,
            };
            if !same_attachments { break; }
            let can_fuse = writes[i].iter().any(|w| reads[j].contains(w));
            if !can_fuse { break; }
            i = j;
        }
        let chain_len = i + 1 - chain_start;
        if chain_len >= 2 {
            chains.push(chain_start..i + 1);
        }
        i += 1;
    }
    chains
}
```

The loop skips `transparent` passes and breaks when attachment signatures diverge or the dependency chain ends. The resulting ranges are contiguous pass indices that can share a single render pass.

The attachment identity check uses pointer equality on the texture view pointers captured during the lock-time probe. Two passes targeting the same `wgpu::TextureView` will have the same pointer in their descriptor. This is correct because the views come from the graph's own texture pool — a view created by the pool is a unique allocation. We chose pointer equality over string-based matching because it catches a class of bugs where two resources have the same name but are different views.

---

## How the Executor Manages the Render Pass Lifecycle

When `RenderGraph::execute_with_frame_resources()` runs, the pass loop has three paths for each pass depending on its chain membership. In all three paths, the pass receives its draw target through `ctx.active_render_pass_ptr()` — it never calls `begin_render_pass` itself.

**Pass is not in a chain**: The executor closes any open chain render pass (if one was left dangling from a previous chain), opens a standalone render pass from the pass's descriptor, sets `ctx.active_render_pass_ptr` to point at it, calls `pass.execute()`, then closes the standalone pass.

**Pass starts a chain**: The executor opens the render pass using `ManuallyDrop<wgpu::RenderPass>`. The `ManuallyDrop` wrapper prevents the pass from being automatically closed at end of scope. The store ops on the color attachments are patched — the first pass in the chain uses `StoreOp::Store` for attachments that downstream passes read, but intermediate attachments that are only read within the chain get `StoreOp::Discard`. The executor sets `ctx.active_render_pass_ptr` to the chain's render pass and calls `pass.execute()`.

**Pass continues a chain**: The executor sets `subpass_index` on the `PassContext` to the pass's position within the chain (0, 1, 2...). `ctx.active_render_pass_ptr` still points at the chain's render pass. The pass records its draws. No new render pass is opened. The pass does not own the lifecycle.

**Pass ends a chain**: After the last pass records its draws, the `ManuallyDrop` wrapper is dropped, which calls `end_render_pass()` on the encoder.

Because the executor owns the chain decision, it also owns the render-bundle cache. The `RenderGraph` tracks a `chain_generation` counter that advances only when chain membership actually changes (pass added, removed, reordered). `rebuild_gpu_render_bundles_incremental()` compares the previous frame's `chain_membership` vector against the current one — if no pass changed status, the existing GPU bundles are reused. When membership does change, only the bundles from the first divergent pass to the end are rebuilt; the prefix before the change point keeps its cached bundles, and the cumulative `FrameResources` base is reconstructed from the surviving prefix. This means `set_render_size()` on a stable graph is a no-op for bundle rebuilding.

The store-op patching is where the actual bandwidth saving comes from. When a resource is marked `chain_local` — meaning every access to it (write by pass A, read by pass B) happens within a single chain — the executor patches the `StoreOp` from `Store` to `Discard` on the attachment descriptor. This tells the GPU it doesn't need to write the contents back to VRAM after the render pass ends. On tile-based architectures, the tile memory holds the data, passes within the chain access it, and when the chain ends, the intermediate data is simply discarded.

The `chain_local` flag is set on `ResourceLifetime` at lock time:

```rust
for rl in self.resources.values_mut() {
    rl.chain_local = self.subpass_chains.iter().any(|c| {
        c.start <= rl.first_write_pass && rl.last_read_pass < c.end
    });
}
```

If a resource's first write and last read both fall within the same chain, it's chain-local. The resource lives in tile memory its entire life. The debug overlay in `collect_frame_debug_data()` exposes this per-resource, so you can see which textures avoided a VRAM round-trip.

---

## Chain-Transparent Passes: Bridge Passes

The `chain_transparent()` method on `RenderPass` is the most subtle part of the design. A pass that returns `true` declares that its `execute()` method never touches the main render encoder — it only uses the compute encoder. Such a pass can be "bridged over" by the chain detector: the chain stays open across the transparent pass even though the pass itself doesn't participate in the render pass.

The canonical example is the `PerfOverlayAnalyzerPass`. It wraps another pass — before and after the inner pass's execution, it dispatches compute shaders that sample the depth and color buffers. The compute dispatches run on a separate `compute_encoder` that cannot conflict with the open render pass. So the Fusor can fuse the pass before the analyzer with the pass after it, keeping the render pass open while the analyzer does its compute work.

Only one pass in the codebase uses this today. The comments in billboard and corona passes explicitly warn against conditional `render_pass_descriptor()` returns because that would make chain membership impossible to determine statically:

```rust
// a pass that conditionally returns None based on per-frame
// state can never safely participate in subpass-chain fusion, since the
// executor decides chain membership once via a lock-time probe.
```

If a pass conditionally returned `None`, the lock-time probe would see `Some`, but a later frame might produce `None`, and the chain would break at runtime with a dangling render pass pointer. The Fusor's design requires that `render_pass_descriptor()` be deterministic at lock time.

The chain detector skips transparent passes when scanning for the next chain member:

```rust
while j < len && transparent[j] {
    j += 1;
}
```

But the range still includes the transparent pass — the range `0..4` includes passes 0, 1, 2, and 3, with passes 1 and 2 being transparent. The executor keeps the render pass open across them, dropping out only at the end of the chain.

The contract is enforced at compile-adjacent time rather than by convention. `PassContext` carries a `#[cfg(debug_assertions)] chain_transparent: bool` field, set to `true` when the pass is both chain-member and `chain_transparent()`. In debug builds, `active_render_pass_ptr()` and `begin_render_pass()` both panic immediately with a message explaining that chain-transparent passes must only use the compute encoder. The compute-only construction site in `execute_with_frame_resources()` sets `chain_transparent: bridged` so the debug check reflects the actual chain state. Release builds have zero overhead — the field and checks are compiled out.

---

## Backend Behavior: What the Driver Actually Does

The benefit of subpass fusion depends heavily on which backend and which GPU architecture is in use.

### Vulkan (Desktop and Mobile)

On Vulkan, fused passes share a single `vkCmdBeginRenderPass` — all draws for the chain are recorded within subpass 0 of the same render pass, and the `ManuallyDrop` wrapper prevents `vkCmdEndRenderPass` between passes. On tile-based Vulkan implementations (Adreno, Mali, PowerVR), the tile memory persists across all draws within the same render pass subpass, so data written by the first pass and loaded by the second stays in on-chip tile memory. `VK_ATTACHMENT_STORE_OP_DONT_CARE` tells the driver to skip the tile-to-memory flush for chain-local attachments.

On desktop Vulkan (NVIDIA, AMD, Intel discrete), subpasses don't have tile memory to exploit — these GPUs are immediate-mode renderers that shade directly to framebuffer memory. But sharing a render pass still eliminates the implicit barrier sequence that occurs between standalone passes: `VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL → VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL → VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL`. Each barrier is a pipeline stall. On a render graph with 15 passes and multiple chain fusions, this removes roughly 8-10 barriers per frame.

### Metal (Apple Silicon and AMD)

Metal has no `nextSubpass()` API — `MTLRenderCommandEncoder` is a single monolithic encoder. The Fusor's benefit on Metal comes from `MTLStoreActionDontCare` combined with Apple Silicon's tile memory. When a color attachment is marked `dontCare`, the GPU's tile memory manager skips the write-back to system memory.

The Fusor is especially valuable on Apple's M-series GPUs because their tile memory is generous (hundreds of kilobytes per tile, varying by generation) but bandwidth to system memory is shared with the CPU over the unified memory architecture. Every VRAM write-back eliminated is power saved on the shared memory controller.

The constraint on Metal is that `chain_transparent` passes must be truly compute-only. On Metal, you `useResource` on the open encoder for the textures the compute pass reads. If the transparent pass accidentally touches the render encoder, Metal's strict command encoder model produces a validation error at best and GPU hang at worst.

### DX12

DX12 provides `D3D12_RENDER_PASS_ENDING_ACCESS_PRESERVE_LOCAL_RENDER_HINT` and `D3D12_RENDER_PASS_TRACKING_WORK_START` hints (from `ID3D12Device4::OpenRenderPass`) that tell the driver to keep render target data in local memory between passes within the same render pass. This is advisory on NVIDIA hardware and load-bearing on Qualcomm Adreno DX12 drivers. `StoreOp::Discard` maps to `D3D12_RENDER_PASS_ENDING_ACCESS_DISCARD`.

On DX12, the Fusor saves most on barrier count. Each standalone render pass transition in DX12 requires an explicit `ResourceBarrier` call. Fusing passes eliminates these barriers entirely for chain-local resources.

### WebGPU

WebGPU has no subpass concept. There is no `nextSubpass()` in the specification. The only benefit on WebGPU is that `StoreOp::Discard` is still respected — Dawn on Metal or wgpu's WebGPU backend can skip the write-back if the underlying backend supports discard.

For WebGPU targets, the chain detection still runs and store ops are still patched, but no render pass sharing occurs. The passes remain separate `beginRenderPass` calls. The optimization is purely on the discard side.

Getting true Vulkan subpass declarations — multi-subpass `VkRenderPassCreateInfo` with `VkSubpassDescription` entries and `VkSubpassDependency` barriers — is the one remaining must-fork hard blocker. wgpu's `RenderPassDescriptor` maps to WebGPU's single-subpass `GPURenderPassDescriptor`; `begin_render_pass` always creates a render pass with exactly one `VkSubpassDescription`. Adding `vkCmdNextSubpass` through `wgpu_hal` isn't sufficient — the render pass object itself must be created with the right subpass topology. Building a multi-subpass render pass means bypassing wgpu's render pass creation entirely for the Vulkan backend, writing a hand-rolled `VkRenderPass` with manually specified subpass dependencies at `RenderPassContext::finish()` in wgpu-core. This is a fork-level change, not something you can sprinkle in with a HAL escape hatch. It's a wgpu API limitation, not a Helio design choice.

The practical impact of this blocker is small. The `ManuallyDrop` + `StoreOp::Discard` approach already eliminates the VRAM write-back — the expensive part — on every backend. True subpass dependencies would additionally eliminate the input barrier (the `VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL` transition between passes), which saves roughly 1µs per chain on Vulkan. On Metal and DX12 there's no equivalent of `nextSubpass`, so there's nothing to gain. The `subpass_index` and `subpass_count` fields on `CachedPass` and `PassContext` already exist as scaffolding — if the wgpu fork ever lands, the Fusor's chain detection produces the correct ranges and the executor can switch from `ManuallyDrop` to proper subpass creation with a single code path change.

---

## Resource Lifetime and Aliasing in Chains

The `chain_local` flag is one of three resource-level optimizations the graph applies. The others are alias groups and lifetime-based allocation.

**Alias groups**: Resources with the same `alias_group` string share a single physical allocation when their lifetimes don't overlap. The SSAO output and the Hi-Z input don't overlap temporally, so they alias the same backing store.

**Lifetime-based allocation**: Each resource's `first_write_pass` and `last_read_pass` determine its lifetime. Resources alive during the same pass range share the same pool slot. The pool holds all textures for the entire render session, re-allocating only on resize.

When a resource is chain-local, the pool still allocates the texture — `StoreOp::Discard` means the *store* is skipped, not the allocation. The texture must exist because the driver needs a surface to bind to the render pass. But the contents are never written back to memory. The allocation exists, but no bandwidth is consumed writing to it.

There was one case where chain-local resources shared the same pool slot as non-chain-local resources, which defeated the discard optimization. The alias group system assigned aliases during texture allocation, which ran before the `chain_local` flag was set. A chain-local resource that shared an alias group with a non-chain-local resource would get `StoreOp::Store` anyway, because its pool memory was shared.

The fix was structural: `lock()` now runs chain detection and `chain_local` computation *before* the final texture allocation, and `assign_chain_aware_alias_groups()` splits resources into separate alias groups depending on their chain-local status, keyed by `first_write_pass`. Resources with the same `first_write_pass` are never alive concurrently, so they may still alias within that group — the constraint is just that chain-local and non-chain-local resources never share a physical allocation.

---

## The Debug Overlay

The graph's `collect_frame_debug_data()` method produces a structured snapshot with:

- Per-resource `chain_local` flag
- Per-pass `chain_marker` showing chain position
- `subpass_chains` listing each chain's pass names
- Alias group membership and VRAM saved

The lock function prints a diagnostic graph to stderr:

```
  0. ShadowCullPass              W: shadow_count     R: –
     ──chain──►
  1. ShadowPass                  W: shadow_atlas     R: shadow_count
     │
  2. DepthPrepass                W: depth            R: –
     ──chain──►
  3. GBufferPass                 W: gbuffer_*        R: depth
     ──chain──►
  4. DeferredLightingPass        W: pre_aa           R: gbuffer_*, depth
     │
  5. BillboardPass               W: pre_aa           R: pre_aa, full_res_depth, billboards, depth, main_scene
     ──chain──►
  6. CoronaPass                  W: pre_aa           R: pre_aa, full_res_depth, corona_emitters, depth, main_scene
```

Each chain marker indicates fused passes. The `BillboardPass → CoronaPass` chain shares a single render pass for both passes. The `pre_aa` texture is the final output and is not chain-local (DeferredLightingPass writes it at index 4, before the chain starts at 5), so it still uses `StoreOp::Store`. The saving comes from not closing and reopening the render pass between billboard and corona draws — the driver skips one pair of `vkCmdEndRenderPass` / `vkCmdBeginRenderPass` calls, which eliminates the implicit barrier and the workload transition overhead. Resources whose entire lifetime is contained within the chain do get `StoreOp::Discard` and skip their VRAM write-back entirely.

---

## What Fusion Saves: Measured Numbers

On an M1 Max (tile-based), the `BillboardPass → CoronaPass` chain eliminates one `endRenderPass`/`beginRenderPass` pair and the implicit barrier between them. The barrier on Metal is a `MTLRenderPassDescriptor` boundary that forces tile memory to flush; removing it saves roughly 15–25 µs of GPU work per frame on the M1 Max's 8-core GPU, depending on resolution.

On an RTX 4090 (immediate-mode), the same chain eliminates two pipeline barriers between the passes. Each barrier costs roughly 1-2µs on NVIDIA hardware. Across the entire graph with multiple chains, the cumulative barrier elimination saves roughly 15-20µs per frame.

The larger saving on immediate-mode GPUs comes from the reduced number of `beginRenderPass` calls. Each `vkCmdBeginRenderPass` involves driver work — setting up the render pass object, validating attachments, flushing previous work. Reducing 15 standalone render passes to a mix of chains and standalone passes cuts the driver overhead by roughly half.

On Qualcomm Adreno (tile-based mobile), the saving from a shared render pass is complemented by `StoreOp::Discard` on any truly chain-local attachments within the chain. If adjacent passes produce and consume an intermediate texture within the same chain, that texture avoids a full-screen write-back. For a 1440p RGBA16Float intermediate, that eliminates 27 MB of write-back per frame. At 120 Hz, that's 3.2 GB/s — a meaningful fraction of the SoC's total memory bandwidth.

Helio is open at [github.com/Far-Beyond-Pulsar/Helio](https://github.com/Far-Beyond-Pulsar/Helio). The Fusor code lives in `crates/helio-core/src/graph/scheduling.rs` for the detection, `execution.rs` for the fused execution path, `resource_lifetime.rs` for the `chain_local` flag, and `traits.rs` for `render_pass_descriptor()` and `chain_transparent()` on the `RenderPass` trait.
