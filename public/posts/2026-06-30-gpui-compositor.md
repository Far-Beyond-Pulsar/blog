---
title: "Making GPUI Fast: A Compositor Thread, an Overscroll Buffer, and Why Browsers Don't Re-Render on Scroll"
date: "2026-06-30"
author: "Tristan Poland"
tags: ["gpui", "wgpu", "rust", "performance", "compositor", "rendering", "architecture"]
description: "How we're planning to pull a CoreAnimation-style compositor thread and a browser-inspired overscroll buffer into GPUI to move essentially all rendering work off the main thread — and why scrolling a massive list should cost near-zero CPU time."
thumbnail: /post_thumb/gpui_compositor.png
---

## The Frame That Wouldn't End

GPUI is a retained-mode UI framework built for the Zed code editor. We did a major rewrite to port it entirely onto wgpu. We use it for editors, tools, browser-like applications with complex layouts, thousands of interactive elements, and real-time rendering requirements. It works. But when the UI gets complex, it stops working well.

The problem isn't subtle. Open a properties panel with a few hundred settings widgets. The moment you scroll, the frame rate drops, the scroll handle lags visibly behind the mouse cursor. The scroll stutters. The CPU profile shows the main thread flat-out for 12-16 milliseconds doing work that, in a browser or a native UI toolkit, would take essentially zero. The work isn't useless — it's sorting primitives by draw order, computing damage rectangles, uploading changed data to GPU buffers, encoding render passes. All necessary work. But none of it should be running on the main thread.

This post is a detailed account of the architecture we're designing to fix that. It is not a post about code we've already shipped. It's a plan — a set of design decisions we've made, tradeoffs we've weighed, and open questions we haven't resolved yet. We're writing it down because the design has reached a point where it's coherent enough to explain, and because writing forces us to confront the gaps we've been hand-waving.

We'll start by understanding where the time goes today, then introduce the two pieces of the architecture — a dedicated compositor thread and an overscroll buffer — and walk through each in depth, ending with the open questions and the implementation roadmap.

---

## What the Main Thread Does Today

GPUI's frame pipeline, from winit event to pixels on screen, looks like this:

```
winit: RedrawRequested
  → on_request_frame callback
    → handle.update(|_, window, cx| window.draw(cx))
      → frame_number += 1
      → invalidate_entities()
      → draw_roots(cx)
        → root_element.prepaint_as_root()
        → root_element.paint(window, cx)
      → finish_layout_frame()
      → text_system().finish_frame()
      → next_frame.finish(&rendered_frame)
        → finish_incremental()    — sort primitives per dirty chunk
        → reconcile_retained_chunks()  — match segments to previous frame
        → compute_damage_rects()  — union dirty chunk bounds
        → collect_changed_ranges()  — gather byte ranges per primitive type
      → mem::swap(&mut rendered_frame, &mut next_frame)
      → next_frame.clear()
    → window.present()
      → platform_window.draw(&scene)
        → upload_primitive_buffer() × 8  — quads, shadows, blurs, etc.
        → path vertex flattening
        → acquire swapchain texture
        → create bind groups
        → begin render pass
        → draw all batches
        → copy to persistent framebuffer
        → queue.submit()
        → surface_texture.present()
```

Every step runs on the main thread, in sequence, with no parallelism between any two steps. The earlier steps produce data consumed by the later ones — `draw_roots` paints primitives into the scene, `finish` sorts and indexes them, `present` uploads and draws them — so there's a real dependency chain. But not all dependencies are equal. Some steps are pure computation on already-owned data. Some are GPU API calls that are thread-safe by design. Some are genuinely main-thread-bound by wgpu's API constraints.

If we profile this pipeline on a realistic workload — a code editor view with tens of thousands of primitives across hundreds of dirty views — the per-frame breakdown reveals a clear split.

Roughly half the frame is the element tree: prepaint, paint, layout. This has to stay on the main thread because it reads and writes Window state, the App entity map, the element arena, the focus state, the hit testing tree, and a dozen other thread-local data structures that are not and will never be thread-safe. That's the irreducible floor.

The other half — finish, upload, render pass — should all be offloadable with the right architecture. Finish is pure computation on `Vec<Quad>`, `Vec<Shadow>`, and friends — all `Send`. Upload calls `wgpu::Queue::write_buffer()`, which is documented as thread-safe. The render pass needs a `wgpu::TextureView` to draw into — the swapchain texture requires the surface, but a pipeline texture (a plain `wgpu::Texture`) is `Send+Sync` and can be used from any thread.

The goal of this architecture is to reduce the main thread's per-frame work to roughly the element tree cost only (plus the unavoidable swapchain acquire+present), and to make the remaining phases either run in parallel on a background thread or, in the case of scrolling, not happen at all.

---

## Architecture Overview: Two Components, One Goal

The design has two major parts, each solving a different piece of the problem.

The **compositor thread** is a dedicated OS thread that takes ownership of scene finishing, GPU upload, and command encoding — everything between the element tree and the swapchain. The main thread builds the element tree and packages the resulting scene into a channel; the compositor does the rest. This gives us parallelism: the main thread can start the next frame while the compositor finishes the current one.

The **overscroll buffer** is a GPU texture larger than the viewport that caches rendered pixels across frames. When the user scrolls, instead of re-rendering everything at a new offset, we blit a different subrect of the buffer to the swapchain. Scrolling becomes a single GPU copy command — no element tree work, no sorting, no uploads. This is the same technique browsers have used for over a decade to make scrolling nearly free.

The two components are independent. You could have a compositor thread without an overscroll buffer (still a win — finish/upload/encode moves off the main thread) or an overscroll buffer without a compositor thread (the overscroll buffer lives on the main thread, but scroll costs near-zero CPU). Together, they give us both parallelism and caching: the compositor renders content into the overscroll buffer, and scrolling hits only the blit path.

Let's walk through each piece in depth.

---

## The Compositor Thread

The compositor thread is the backbone of the architecture. It takes everything that currently runs in `Window::draw()` after `draw_roots` and runs it on a background thread, then signals the main thread that a frame is ready to present.

### Why a Dedicated Thread Instead of the Task Pool

GPUI already has a `BackgroundExecutor` — a priority threadpool with three levels. Using it for compositor work would avoid creating new thread infrastructure. We considered it and rejected it for three reasons.

First, the compositor needs guaranteed access to GPU resources that can't be contended with other background work. If a file I/O task and a compositor task are both scheduled on the threadpool, the compositor could be delayed by a slow disk read. File I/O should never delay rendering. A dedicated thread avoids this — the compositor is always one scheduling decision away from a free core.

Second, the compositor needs to own GPU resources that aren't thread-safe to share. The `WgpuPipelines` struct holds shader modules, pipeline layouts, bind group layouts, and pipeline objects. These are `Send + Sync` in theory, but in practice they're expensive to create and destroy. A dedicated thread avoids the need to share them at all — they're created once on the compositor thread and live there for the session.

Third, the pacing is simpler with a dedicated thread. The compositor runs a tight loop: wait for work, process it, signal completion, wait for work again. There's no scheduling jitter. The main thread knows exactly where the compositor is in its lifecycle at any point.

The cost is one OS thread per compositor instance. For an application with one window, that's one extra thread. For multi-window applications, each window would need its own compositor. We have a mitigation — falling back to the threadpool for multi-window cases — which we'll cover later.

### The Channel Protocol

The main thread and compositor communicate through two `flume` channels, one in each direction:

```rust
pub(crate) struct FrameCompositor {
    // Main → Compositor: work submissions
    commit_tx: flume::Sender<CompositorJob>,
    resize_tx: flume::Sender<ResizeEvent>,

    // Compositor → Main: completed frames
    completion_rx: flume::Receiver<CompletedFrame>,

    // Thread handle
    thread: Option<std::thread::JoinHandle<()>>,
}
```

We chose `flume` over `crossbeam` or `std::sync::mpsc` because it's fast (near the theoretical minimum for channel operations) and has a convenient `try_send` / `try_recv` API that we use heavily for non-blocking communication. The channels are bounded with capacity 1:

```rust
let (commit_tx, commit_rx) = flume::bounded(1);
let (completion_tx, completion_rx) = flume::bounded(1);
```

Capacity 1 is deliberate. An unbounded channel would let the main thread get arbitrarily far ahead of the compositor, queuing up scenes that will be stale by the time they're processed. With capacity 1, if the compositor is busy and the main thread tries to send a new commit, `try_send` returns `Full` immediately. The main thread drops the scene — the next `draw_roots` call will build a fresh scene with all accumulated changes, and the compositor will pick it up when it's ready. This is frame dropping in the classic game-engine sense: when the producer is faster than the consumer, skip frames rather than queueing them.

This was not our first instinct. We started with an unbounded channel because "what if the compositor needs to queue work?" The answer is: it doesn't. The compositor should never be ahead of the main thread by more than one frame. If it is, you're either overproducing scenes (build them less often) or under-consuming them (make the compositor faster). Dropping frames with `try_send` paces the main thread to the compositor's speed automatically, and it's the right behavior.

The job type is an enum so we can distinguish full commits from partial updates:

```rust
pub(crate) enum CompositorJob {
    /// Full scene from scratch — replace everything in the overscroll buffer
    Commit {
        scene: Scene,
        overscroll_origin: Point<ScaledPixels>,
    },

    /// Render only the specified rect of the scene into the overscroll buffer
    ExtendTiles {
        scene: Scene,
        render_rect: Bounds<ScaledPixels>,
    },

    /// Re-center the overscroll buffer and render exposed edges
    ReCenter {
        scene: Scene,
        old_origin: Point<ScaledPixels>,
        new_origin: Point<ScaledPixels>,
    },
}
```

The `Commit` variant is for when content has actually changed — a keyboard input, a view invalidation, an animation frame. The `ExtendTiles` and `ReCenter` variants are for the overscroll fast path — the scene hasn't changed, just which part of it is visible.

The completion signal is minimal:

```rust
pub(crate) struct CompletedFrame {
    pub generation: u64,
    pub rendered_rect: Bounds<ScaledPixels>,
}
```

The main thread doesn't need the finished scene back — it was already moved into the compositor. All it needs to know is that the pipeline texture has valid content and what bounds of that content are up-to-date.

### The Compositor State

The compositor thread runs a single function that owns all rendering state:

```rust
struct CompositorState {
    // GPU resources (shared Arc from main thread)
    context: Arc<WgpuContext>,

    // Compositor-exclusive resources (created on this thread)
    pipelines: WgpuPipelines,
    atlas: Arc<WgpuAtlas>,
    sampler: wgpu::Sampler,

    // Pipeline texture (the compositor's render target)
    overscroll: OverscrollBuffer,

    // Scene state for damage comparison
    previous_scene: Scene,

    // Upload tracking (generations + sizes)
    upload_states: PrimitiveUploadStates,

    // Channels
    commit_rx: flume::Receiver<CompositorJob>,
    resize_rx: flume::Receiver<ResizeEvent>,
    completion_tx: flume::Sender<CompletedFrame>,
}
```

The `WgpuContext` is behind `Arc` — it's the same context the main thread's renderer uses. We considered creating a separate device for the compositor but decided against it. Sharing the device avoids the need for cross-device resource sharing (which wgpu doesn't support for textures) and simplifies the synchronization model — both threads submit to the same queue, so GPU-side ordering is automatic.

The `WgpuPipelines` and `WgpuAtlas` are currently owned by the `WgpuRenderer` on the main thread. In the new architecture, they move to the compositor. The main thread never creates pipelines or touches the atlas directly — those operations are all compositor responsibilities. The atlas is shared behind `Arc` because the main thread still needs to issue atlas slot allocation requests from image loading and glyph rasterization, but the actual texture uploads (`atlas.before_frame()`) happen on the compositor thread inside the command encoder.

### What Stays on the Main Thread

The `WgpuRenderer` on the main thread is reduced to surface management and blitting:

```rust
pub struct WgpuRenderer {
    context: Arc<WgpuContext>,
    surface: ManuallyDrop<wgpu::Surface<'static>>,
    window: Option<Arc<winit::window::Window>>,
    surface_configuration: wgpu::SurfaceConfiguration,

    // Compositor handle
    compositor: FrameCompositor,

    // Persistent framebuffer for the fallback path
    persistent_framebuffer: Option<wgpu::Texture>,
    persistent_framebuffer_view: Option<wgpu::TextureView>,
    persistent_framebuffer_has_frame: bool,
}
```

Its `draw` method (which currently does everything) becomes a thin wrapper. The `present()` call becomes: poll for completed frame, blit from pipeline texture to swapchain, submit, present. That's it. No uploads, no render pass, no bind group management. The heavy work was already done on the compositor thread.

```rust
impl WgpuRenderer {
    fn present_completed_frame(&self) -> bool {
        let completed = match self.compositor.try_recv_completed() {
            Some(c) => c,
            None => return false,
        };

        self.overscroll.update_rendered_rect(completed.rendered_rect);

        let swapchain_tex = match self.surface.get_current_texture() {
            Ok(tex) => tex,
            Err(e) => {
                log::error!("swapchain acquire failed: {:?}", e);
                return false;
            }
        };

        let mut encoder = self.context.device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("blit"),
            });

        let blit_origin = self.compositor.blit_origin_for_viewport(
            self.scroll_offset(),
        );

        encoder.copy_texture_to_texture(
            wgpu::ImageCopyTexture {
                texture: &self.compositor.pipeline_texture(),
                mip_level: 0,
                origin: blit_origin,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::ImageCopyTexture {
                texture: &swapchain_tex.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: self.surface_configuration.width,
                height: self.surface_configuration.height,
                depth_or_array_layers: 1,
            },
        );

        self.context.queue.submit([encoder.finish()]);
        swapchain_tex.present();
        self.persistent_framebuffer_has_frame = true;
        true
    }
}
```

### The Pipeline Texture

The pipeline texture is a `wgpu::Texture` that serves as the compositor's render target. In the base configuration (without overscroll), it's viewport-sized. In overscroll mode, it's larger:

```rust
struct OverscrollBuffer {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    overscroll_factor: u32,          // 3 for 3x viewport
    format: wgpu::TextureFormat,

    // Where content (0,0) is located within the texture
    content_origin: Cell<Point<i32>>,

    // What portion of the texture has valid rendered content
    rendered_rect: Cell<Bounds<i32>>,
}
```

The texture is created with `wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST`. `RENDER_ATTACHMENT` because the compositor draws into it. `COPY_SRC` because the main thread blits from it to the swapchain. `COPY_DST` because the compositor may need to shift content within it (for re-centering).

Creation looks like:

```rust
impl OverscrollBuffer {
    fn new(
        device: &wgpu::Device,
        viewport_width: u32,
        viewport_height: u32,
        factor: u32,
        format: wgpu::TextureFormat,
    ) -> Self {
        let size = wgpu::Extent3d {
            width: viewport_width * factor,
            height: viewport_height * factor,
            depth_or_array_layers: 1,
        };

        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("overscroll_buffer"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });

        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

        // Content origin starts at the center of the overscroll buffer
        let half = (factor / 2) as i32;
        let content_origin = Point::new(
            half * viewport_width as i32,
            half * viewport_height as i32,
        );

        Self {
            texture,
            view,
            overscroll_factor: factor,
            format,
            content_origin: Cell::new(content_origin),
            rendered_rect: Cell::new(Bounds::default()),
        }
    }
}
```

The memory cost is significant but acceptable. At 2560×1440 with overscroll factor 3, the texture is 7680×4320. At 4 bytes per pixel (RGBA8), that's about 127 MB. At 4K (3840×2160), it's 11520×6480 — about 286 MB. On any GPU with 4+ GB of VRAM, this is fine. For the WebGPU target or low-end integrated GPUs, we plan to make the factor configurable — an environment variable (`GPUI_OVERSCROLL_FACTOR=1` disables it) or a runtime limit query.

---

## The Fill Pipeline: What the Compositor Does

When the compositor receives a `Commit` job, it runs through the same pipeline that `Window::draw()` + `WgpuRenderer::draw()` currently run, but on the compositor thread and targeting the pipeline texture instead of the swapchain. Here's the detailed breakdown of each step and why it's safe to run off the main thread.

### Step 1: Scene Finishing

```rust
scene.finish_with_previous_scene(&self.previous_scene);
```

This is the pure-computation phase. It sorts primitives within dirty chunks, reconciles retained segment IDs from the previous frame, computes damage rectangles for dirty chunks, and collects changed byte ranges per primitive type. The scene data is all `Send` — `Vec<Quad>`, `Vec<Shadow>`, `Vec<Path>`, `FxHashMap<EntityId, usize>`, `Vec<SceneChunk>`, `Vec<Bounds<ScaledPixels>>` — none of it touches anything on the main thread. Every type in the transitive closure of `Scene` is trivially Send.

The `finish_with_previous_scene` method reads the previous scene for damage comparison. The previous scene is owned by the compositor state — it was the scene from the last commit. On the first commit, the previous scene is empty and `finish` computes a full-frame damage rect. On subsequent commits, damage is incremental.

### Step 2: Path Vertex Flattening

```rust
fn upload_path_vertices(&mut self, scene: &Scene) {
    let mut flat_vertices: Vec<GpuPathVertex> = Vec::new();
    for path in &scene.paths {
        let color = path.color.solid;
        let cm = &path.content_mask.bounds;
        for vertex in &path.vertices {
            flat_vertices.push(GpuPathVertex {
                xy_position: [vertex.xy_position.x.0, vertex.xy_position.y.0],
                st_position: [vertex.st_position.x, vertex.st_position.y],
                hsla: [color.h, color.s, color.l, color.a],
                content_mask_origin: [cm.origin.x.0, cm.origin.y.0],
                content_mask_size: [cm.size.width.0, cm.size.height.0],
            });
        }
    }

    let generation = scene.scene_generation();
    let changed = scene.changed_ranges();
    Self::upload_primitive_buffer(
        &self.context,
        &mut self.upload_states.paths_vertices,
        generation,
        &self.context.paths_vertices_buffer,
        "Paths Vertices Buffer",
        wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::STORAGE,
        unsafe { as_bytes(&flat_vertices) },
        std::mem::size_of::<GpuPathVertex>(),
        &changed.paths,
    );
}
```

This is a pure data transformation — building a flat vertex array from each path's tessellated vertices, baking color and content mask values into each vertex. No main-thread state is read or written. The output is written directly to a GPU buffer via `queue.write_buffer`, which is thread-safe.

### Step 3: Per-Type Upload Decisions

Each primitive type (quads, shadows, underlines, etc.) has an associated `PrimitiveUploadState` that tracks the last uploaded generation and byte length. The upload decision function compares the current scene generation against the recorded generation:

```rust
fn upload_decision(
    &mut self,
    scene_generation: u64,
    data_len: usize,
    changed_byte_ranges: Vec<Range<usize>>,
) -> PrimitiveUploadDecision {
    if scene_generation == self.generation && data_len == self.byte_len {
        // Nothing changed — skip entirely
        return PrimitiveUploadDecision::Skip;
    }
    if data_len != self.byte_len {
        // Buffer size changed — full re-upload
        return PrimitiveUploadDecision::Full;
    }
    if changed_byte_ranges.is_empty() {
        // Generation changed but no byte-level changes (rare)
        return PrimitiveUploadDecision::RecordOnly;
    }
    // Partial upload of dirty byte ranges
    PrimitiveUploadDecision::Ranges(changed_byte_ranges)
}
```

The upload state is compositor-owned (`PrimitiveUploadStates` in `CompositorState`), so there's no contention with the main thread. For the `Full` decision, we call `ensure_buffer_size` which may re-create the GPU buffer — `device.create_buffer()` is thread-safe. For the `Ranges` decision, we iterate the dirty byte ranges and call `queue.write_buffer()` for each.

### Step 4: Atlas Uploads

```rust
self.atlas.before_frame(&mut encoder);
```

The atlas texture is shared between the main thread and the compositor behind `Arc<WgpuAtlas>`. Internally, `WgpuAtlas` uses `Mutex` for its state — slot allocation, pending initialization queues, and dirty rect tracking are all behind a mutex. This means `before_frame()` is safe to call from the compositor thread.

The main thread still initiates atlas slot allocations (when a new image is loaded or a glyph is rasterized) by calling into the atlas, which queues the allocation behind the mutex. When the compositor calls `before_frame()`, it locks the mutex, drains the pending initialization queue, records the necessary texture upload commands into the encoder, and releases the lock. The main thread never holds the atlas lock during `draw_roots`, so there's no deadlock — only brief contention when the main thread allocates a slot while the compositor is in `before_frame()`.

In practice, we expect this contention to be negligible. Atlas slot allocation happens sporadically (when new glyphs appear, when images are first loaded). During steady-state scrolling, no new atlas allocations happen, and `before_frame()` is a no-op that grabs the lock, sees an empty queue, and releases it in under a microsecond.

### Step 5: Render Pass

```rust
let load_op = if self.overscroll.needs_full_clear() {
    wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
} else {
    wgpu::LoadOp::Load
};

{
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("compositor"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &self.overscroll.view,
            resolve_target: None,
            ops: wgpu::Operations {
                load: load_op,
                store: wgpu::StoreOp::Store,
            },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
    });

    self.draw_all_batches(&mut pass, &scene);
}
```

The render pass draws all primitive batches into the overscroll buffer. This is the same batched draw calls for quads, shadows, backdrop blurs, underlines, sprites, paths, and surfaces — just targeted at a persistent pipeline texture instead of a per-frame swapchain texture.

The `load_op` is `LoadOp::Clear` for the first frame or after a recenter, and `LoadOp::Load` for partial updates where we're extending tiles into an already-valid area. Using `Load` avoids clearing pixels that are already correct from a previous render.

After the render pass ends, the command encoder is finished and submitted:

```rust
let cmd_buf = encoder.finish();
self.queue.submit([cmd_buf]);
```

The `wgpu::Queue` is behind `Arc` and shared with the main thread. Submitting to it from the compositor thread is safe because `Queue::submit()` uses internal synchronization (a `Mutex` in wgpu-core). The main thread also submits to the same queue (for blit commands), and the channel ensures that the compositor's submit happens before the main thread's blit submit.

### Step 6: Signal Completion

```rust
self.previous_scene = scene;
self.overscroll.mark_rendered();
self.completion_tx.send(CompletedFrame {
    generation: self.previous_scene.scene_generation(),
    rendered_rect: self.overscroll.rendered_rect(),
}).ok();
```

The compositor stores the finished scene as `previous_scene` for the next frame's damage comparison, marks the overscroll buffer's rendered area as valid, and sends a completion signal to the main thread. The main thread picks this up on its next `try_present()` call.

---

## The Overscroll Buffer

The compositor thread removes the finish and upload phases from the main thread's per-frame budget, which is meaningful. But the overscroll buffer removes almost the entire frame cost from every scroll interaction, which is transformative. When we pitched this design to our team, everyone focused on the compositor thread because it sounds more impressive. The overscroll buffer is the part that will actually make scrolling feel instantaneous.

### How Browsers Handle Scroll

Here's a deceptively simple question: when you scroll a web page, what does the browser actually render?

The answer, on any modern browser, is approximately nothing. Open Chrome's frame profiler, scroll a long article, and watch the per-frame breakdown. The vast majority of frames show zero layout and zero paint. The profiler shows a single `composite` or `copy` operation and nothing else. The pixels on screen are being moved, not recomputed.

The mechanism is an **overscroll buffer** — a GPU texture that's typically 2-3x the viewport size in each dimension. When the page first loads, the browser renders a generous area around the initial viewport into this texture. As the user scrolls, the browser shifts the UV coordinates of the blit that copies from the overscroll buffer to the swapchain. The content was rendered once. Scrolling is just a texture lookup with a changing offset.

When the user scrolls far enough that the viewport would intersect un-rendered content — the edge of the overscroll buffer — the browser does one of two things. In Chrome/Blink, it rasterizes new tiles at the page's edge in a background compositor thread, extending the valid area of the texture. In Safari/WebKit, it re-centers the overscroll buffer by copying existing content to a new position within the texture and rasterizing only the newly-exposed edges. Either way, the expensive operation — rasterization — is a partial update that affects only the margins of the buffer, not the entire visible area. The next thousand pixels of scroll are free again.

### How GPUI Handles Scroll Today

GPUI is a retained-mode framework, meaning elements define their structure once and the framework diffs changes between frames. But "retained" applies to the element tree, not to the rendered output. Every frame, GPUI walks the element tree, generates scene primitives, sorts them, uploads them, and draws them. If the user scrolls, the scroll offset changes, the element tree re-renders its children at new positions, and the entire pipeline runs again. The content is identical to the previous frame but shifted by a few pixels. The framework pays the full cost of re-rendering all of it.

The potential savings are enormous. For a scrollable text editor with thousands of lines, scrolling by a few lines doesn't change the content of the vast majority of visible lines — it only changes their position on screen. A few lines may enter or leave the viewport at the edges, requiring new glyphs to be laid out and painted. But almost all of the visible content is pixel-identical to the previous frame, just shifted. Re-rendering it all from scratch is burning CPU time to produce a result we already have.

### The Three-Case Scroll Model

The overscroll buffer approach fixes this by making "content changed" and "viewport position changed" two different concepts. Every scroll event is classified into one of three cases.

**Case 1: Viewport is within the rendered area.** This is the common case for most of a scrolling session. The user has scrolled, but the new visible rect is still entirely inside the area of the overscroll buffer that has valid rendered content. The main thread does nothing on the rendering side — it just updates the scroll offset in application state, and the next present uses a different blit origin.

The blit origin is computed from the scroll offset and the overscroll buffer's content origin:

```rust
fn blit_origin_for_viewport(&self, scroll_offset: Point<i32>) -> wgpu::Origin3d {
    wgpu::Origin3d {
        x: (self.content_origin.x - scroll_offset.x).max(0) as u32,
        y: (self.content_origin.y - scroll_offset.y).max(0) as u32,
        z: 0,
    }
}
```

This maps the current viewport position (in content space) to the corresponding region of the overscroll texture. As long as the resulting rect fits within `rendered_rect`, no rendering work is needed.

**Case 2: Viewport exceeds rendered area (needs tile extension).** The user scrolled far enough that part of the viewport would read unrendered pixels. A `CompositorJob::ExtendTiles` is sent to the compositor specifying which region needs rendering:

```rust
fn schedule_tile_extension(&mut self) {
    let viewport = self.current_viewport();
    let rendered = self.overscroll.rendered_rect();

    let needed = viewport.difference(&rendered);

    if needed.is_empty() {
        return; // Fast path: viewport is fully within rendered area
    }

    let scene = self.build_scene_for_rect(needed);

    self.compositor.commit_tx.try_send(CompositorJob::ExtendTiles {
        scene,
        render_rect: needed,
    }).ok();
}
```

The compositor's `ExtendTiles` handler does a partial render pass — it only draws primitives whose chunks intersect the requested rect. The rest of the overscroll buffer is not cleared or re-drawn:

```rust
fn handle_extend_tiles(&mut self, scene: Scene, render_rect: Bounds<ScaledPixels>) {
    let mut encoder = self.device.create_command_encoder(/*...*/);
    self.atlas.before_frame(&mut encoder);

    let has_work = scene.chunks.iter().any(|chunk| {
        chunk.dirty && scene.chunk_bounds(chunk)
            .map_or(false, |b| b.intersects(render_rect))
    });

    if has_work {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.overscroll.view,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,  // Don't clear — keep existing content
                    store: wgpu::StoreOp::Store,
                },
                ..Default::default()
            })],
            ..Default::default()
        });

        for chunk in scene.chunks.iter().filter(|c| c.dirty) {
            if scene.chunk_bounds(chunk).map_or(true, |b| b.intersects(render_rect)) {
                self.draw_dirty_chunk(&mut pass, &scene, chunk, &render_rect);
            }
        }
    }

    self.queue.submit([encoder.finish()]);
    self.overscroll.extend_rendered_rect(render_rect);
    self.previous_scene = scene;
    self.completion_tx.send(CompletedFrame {
        generation: self.previous_scene.scene_generation(),
        rendered_rect: self.overscroll.rendered_rect(),
    }).ok();
}
```

The `draw_dirty_chunk` method clips the scissor rect to the intersection of the chunk and the `render_rect`, ensuring we don't waste GPU time shading pixels outside the area that needs updating.

**Case 3: Content origin has drifted too far (needs re-center).** Over many scroll events, the content origin in the overscroll buffer drifts away from the center as the user scrolls in one direction. When it approaches the edge of the texture, we need to re-center. The compositor shifts existing content within the texture (a GPU-to-GPU copy) and renders the newly-exposed edges:

```rust
fn handle_recenter(
    &mut self,
    scene: Scene,
    old_origin: Point<i32>,
    new_origin: Point<i32>,
) {
    let mut encoder = self.device.create_command_encoder(/*...*/);

    // Step 1: Copy valid content from old position to new position
    let shift = new_origin - old_origin;
    let valid_area = self.overscroll.rendered_rect();
    let copy_extent = /*...*/;

    encoder.copy_texture_to_texture(
        src_at_old_origin,
        dst_at_new_origin,
        copy_extent,
    );

    // Step 2: Render newly-exposed edges
    self.atlas.before_frame(&mut encoder);

    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: &self.overscroll.view,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Load,
                store: wgpu::StoreOp::Store,
            },
            ..Default::default()
        })],
        ..Default::default()
    });

    let new_edges = /* union of rects that became visible after the shift */;
    for chunk in scene.chunks.iter().filter(|c| c.dirty) {
        if let Some(bounds) = scene.chunk_bounds(chunk) {
            if bounds.intersects(new_edges) {
                let scissor = bounds.intersection(&new_edges);
                pass.set_scissor_rect(scissor.x, scissor.y, scissor.w, scissor.h);
                self.draw_chunk(&mut pass, &scene, chunk);
            }
        }
    }

    drop(pass);
    self.queue.submit([encoder.finish()]);

    self.overscroll.set_origin(new_origin);
    // ... update rendered_rect
}
```

The GPU copy of existing content within the same texture is handled by the driver as a simple DMA transfer — a few microseconds of CPU time to submit the copy command, with the actual data movement happening entirely on the GPU timeline.

### Deciding Which Case to Use

The decision is made in `Window::try_present()`, which is called on every `RedrawRequested` event:

```rust
fn try_present(&mut self) -> PresentResult {
    if self.renderer.try_present_completed() {
        return PresentResult::Presented;
    }

    if self.overscroll.covers(self.current_viewport()) {
        self.renderer.blit_overscroll_to_swapchain(
            self.overscroll.blit_origin_for_viewport(self.scroll_offset()),
        );
        return PresentResult::PresentedNoComposite;
    }

    if self.overscroll.nearly_exceeded(self.current_viewport()) {
        self.schedule_tile_extension();
    }

    self.renderer.present_framebuffer_only();
    PresentResult::ShowCached
}
```

This is called on every `RedrawRequested`, not just when state is dirty. The winit event loop runs with `ControlFlow::Poll`, so we get regular callbacks. Most of the time, a frame is either ready from the compositor or the overscroll buffer covers the viewport, and we present with minimal work.

The `covers()` check is a simple bounds comparison. The `nearly_exceeded()` check adds a margin — we trigger a tile extension when the viewport approaches the rendered area's edge, so the extension has time to complete before the user actually reaches it:

```rust
fn nearly_exceeded(&self, viewport: Bounds<ScaledPixels>) -> bool {
    let rendered = self.rendered_rect();
    let margin = viewport.size() * INSET_MARGIN_FRACTION;
    !rendered.inset(margin).contains_rect(viewport)
}
```

### The Memory Tradeoff

The overscroll buffer at 3x 1440p is ~127 MB. At 5K (5120×2880, common on high-DPI displays), it's over 500 MB. That's a lot of GPU memory.

The plan is to make the overscroll factor configurable per-window:

- **Desktop with discrete GPU**: factor = 3 (default)
- **Desktop with integrated GPU**: factor = 2
- **WebGPU / wasm**: factor = 1 (disabled, fall back to synchronous)
- **Programmatic override**: `GPUI_OVERSCROLL_FACTOR=1` environment variable

The factor can also be adjusted based on `wgpu::Limits::max_texture_size`. If the maximum texture size is smaller than `viewport * factor`, we clamp to the limit.

At factor 1, the overscroll buffer is viewport-sized. The compositor still provides parallelism (offloading finish + upload + encoding), but every frame requires a full render — no cached content to shift. This is still a meaningful improvement even without the scroll optimization.

### When the Overscroll Buffer Breaks

There's a reason an overscroll buffer wasn't the default from day one. The trick works perfectly when content has stable height — fixed line heights in a code editor, uniform row heights in a list, known element sizes in a file tree. An element that was at Y position 1000 on frame N is still at Y position 1000 on frame N+1, just offset by the scroll delta. The cached pixels remain valid.

The trick breaks when elements above the viewport can change height unpredictably. If an element at Y=200 grows by 50 pixels, every element below it shifts down by 50 pixels. The overscroll buffer now shows stale content at wrong positions — the pixels are there, but they've moved. You can't just blit with an offset anymore; you need to re-render the affected region. If elements change height frequently, the overscroll buffer provides no benefit and adds complexity.

This is the fundamental tension. Browsers deal with it because the web's layout model has relatively stable block sizes during scroll — changes are driven by explicit events (image load, font swap, media query), not by the act of scrolling itself. When a change does happen, the browser invalidates the affected tiles and re-rasterizes them. It's a tile invalidation problem, not an impossibility. But it imposes real engineering cost: every tile needs dirty tracking, every rendered region needs versioning, and every scroll needs an invalidation check.

GPUI's `List` and `UniformList` elements already exploit a similar principle at the element tree level — they cache layout data for offscreen items and skip prepaint for anything outside the viewport, re-laying-out only items that scroll into view. The overscroll buffer operates at a completely different level of the stack. Instead of caching element data and re-painting items on scroll, it caches rendered pixels — the output of the entire pipeline. A `List` item that enters the viewport via scrolling within the overscroll buffer doesn't need to be painted, sorted, uploaded, or drawn. It was already painted into the buffer on a previous frame. The GPU just shifts the pixels. This is a fundamentally stronger cache: it skips everything below the element tree rather than just reducing how many items the tree has to process.

For variable-height content, the overscroll buffer degrades gracefully. Every content change triggers a full commit (the same as today), and the buffer is re-rendered. The fast scroll path only activates during scrolls that don't involve height changes. This is the pragmatic middle ground: get the win for the common case, fall back for the edge case, and never produce incorrect output.

---

## Separating Content from Viewport in the Element Tree

The overscroll buffer is the GPU-side mechanism. But the harder problem is on the CPU side: how do we prevent scroll events from triggering a full `cx.notify()` → draw_roots → commit cycle when the only thing that changed is the viewport position?

Currently, scrolling works like this:
1. A scroll event arrives at the window.
2. The window routes it to the focused element (typically a scroll container).
3. The scroll container updates its internal scroll offset.
4. The scroll container calls `cx.notify()`.
5. The view re-renders, which marks all children dirty.
6. Every visible element is re-laid-out and re-painted at the new offset.
7. The resulting scene is sorted, uploaded, and drawn.

Steps 4-7 are the waste. The content didn't change. The only thing that changed is the scroll offset, which affects the position of existing elements, not their content. But the framework has no way to distinguish "I want to re-render because my content changed" from "I want to re-render because my scroll position changed." Both call `cx.notify()`.

The proposed solution has two parts.

### Part 1: Window-Level Scroll Tracking

The window maintains a cumulative scroll offset that reflects the scroll state of the entire active scrollable view. This is separate from the element tree's scroll offset — the element tree still tracks position for hit testing and focus navigation, but the window uses its own copy for rendering decisions:

```rust
// In Window:
struct ScrollState {
    /// Accumulated scroll offset from all scroll events.
    /// Updated on every scroll event, read during present.
    total_offset: Point<ScaledPixels>,

    /// The scroll offset at the time of the last compositor commit.
    /// When total_offset differs from last_committed_offset by more
    /// than the overscroll margin, we know we need a tile extension.
    last_committed_offset: Point<ScaledPixels>,

    /// Whether the last draw_roots was triggered by a scroll event
    /// (as opposed to a content change).
    scroll_only: bool,
}
```

When a scroll event arrives, the window handler checks whether the scroll event's effect on the element tree would be limited to viewport translation:

```rust
fn handle_scroll_event(&mut self, delta: ScrollDelta, cx: &mut App) {
    self.dispatch_scroll_event(delta, cx);

    self.scroll_state.total_offset += delta.pixel_delta();

    // Check: did the element tree produce any non-scroll changes?
    // The exact heuristic: if only scroll containers called cx.notify()
    // and no other state changed, this was a scroll-only event.
    // Scroll containers call a different method (cx.scrolled()) that
    // doesn't mark the view dirty but still updates layout offset.

    if self.scroll_state.scroll_only {
        self.needs_present.set(true);
    } else {
        self.needs_commit = true;
    }
}
```

### Part 2: Differentiated Notification

The cleanest version of this requires changes to the scroll container elements (`UniformList`, `List`, scrollable `div`). Instead of calling `cx.notify()` on every scroll event, they would call a new method that updates scroll state without triggering a full re-render:

```rust
// Proposed: updates position without re-rendering
fn on_scroll(&mut self, delta: Vec2<f32>, window: &mut Window, cx: &mut ViewContext<Self>) {
    self.scroll_offset += delta;
    window.record_scroll(self.scroll_offset);
    // cx.notify() is NOT called — no re-render unless content changes
}
```

The `window.record_scroll()` call updates the window's scroll state and marks `needs_present` without triggering a commit. The next `try_present()` sees that the viewport has shifted but the overscroll buffer still covers it, and does a zero-work blit.

This is the most architecturally invasive part of the design — it changes the fundamental contract of how scroll containers interact with the rendering pipeline. The current thinking is to support both paths: scroll containers can opt into the efficient path by calling `window.record_scroll()`, and the window will also attempt to detect scroll-only events automatically for containers that don't opt in.

### Hit Testing and Focus

Hit testing in GPUI runs against the rendered frame's hitboxes, which are built during `draw_roots`. If we skip `draw_roots` for scroll-only events, the hitboxes would still reflect the old scroll position. The solution is to apply the scroll offset to the hit testing results:

```rust
fn hit_test(&self, position: Point<Pixels>) -> HitTestResult {
    let adjusted_position = position + self.scroll_state.total_offset
        - self.scroll_state.last_committed_offset;
    self.rendered_frame.hit_test(adjusted_position)
}
```

This works because the element structure hasn't changed — only the scroll offset. Elements are at the same relative positions within the scroll container; the container itself has moved. Subtracting the scroll delta from the hit test position effectively "unscrolls" the input to match the rendered frame's coordinate space.

Focus is driven by `TabIndex` and keyboard navigation, both tracked in the rendered frame. Since we're not re-rendering on scroll, the focus state from the last commit is still valid — the focused element hasn't moved relative to its scroll container, only the container has moved. Focus painting uses the same scroll-offset-adjusted coordinates as hit testing.

### Animations and Text Input

Animations that change element properties (opacity, color, transform) need to trigger a full commit. The animation system already calls `cx.notify()` on each frame, so this works correctly — the scroll separation doesn't affect animations. The compositor receives a new scene every animation frame and renders it into the overscroll buffer.

Animations that only affect position (like a smooth-scroll animation that interpolates scroll offset across multiple frames) should ideally use the overscroll fast path. The animation would update the scroll offset each frame without a commit, and the blit origin would smoothly track the animated offset. This requires the animation system to distinguish "position animation" from "property animation." We haven't designed this yet.

Text input changes content — every keystroke modifies text, which changes the element tree. These always trigger `cx.notify()` and a full commit. The overscroll buffer offers no benefit here, but it doesn't hurt either — the commit re-renders the entire visible area into the overscroll buffer, and subsequent scroll events within the buffer are fast again. The typical editing pattern — type a few characters, scroll to a new position, type more characters — alternates between full commits and fast scrolls. The user pays for the commits when they edit, but not when they scroll.

---

## Thread Safety: What We Checked and What We're Assuming

A significant amount of the design work went into verifying that the data and GPU operations we're moving to the compositor thread are actually safe to move. Here's what we checked.

### Scene and All Contained Types

We audited the entire transitive type graph of `Scene` for `!Send` types. The result: every type in the graph is `Send + Sync`. There are no `Rc`, `RefCell`, `NonNull`, raw pointers, or thread-local types. All heap allocation uses `Vec`, `HashMap`, `FxHashMap`, or `FxHashSet` — all of which are `Send` when their contents are.

We spent two weeks on a theoretical analysis of thread safety that would have been faster if we'd just run `cargo doc --document-private-items` and checked the `Send` impls. The Scene types are all trivially Send, which we confirmed in a single afternoon once we actually looked.

The full audit list:

| Type | File | Heap | Send | Notes |
|---|---|---|---|---|
| `Scene` | `scene/state.rs` | Vectors, HashMap | Yes | All fields trivially Send |
| `Quad` | `scene/primitive.rs` | Inline | Yes | f32, u32, Bounds, etc. |
| `Shadow` | `scene/primitive.rs` | Inline | Yes | |
| `BackdropBlur` | `scene/primitive.rs` | Inline | Yes | |
| `Underline` | `scene/primitive.rs` | Inline | Yes | |
| `MonochromeSprite` | `scene/primitive.rs` | Inline (AtlasTile) | Yes | AtlasTile is Send |
| `PolychromeSprite` | `scene/primitive.rs` | Inline (AtlasTile) | Yes | |
| `PaintSurface` | `scene/primitive.rs` | Inline (SurfaceId) | Yes | SurfaceId is u64 |
| `Path<ScaledPixels>` | `scene/path.rs` | Vec<PathVertex> | Yes | |
| `BoundsTree<ScaledPixels>` | `bounds_tree.rs` | Vec<Node> | Yes | |
| `SceneSegmentPool` | `retained/scene.rs` | FxHashSet | Yes | |
| `PrimitiveBatches` | `gpui-render-primitive` | HashMap + Vec | Yes | |
| `PaintOperation` | `scene/primitive.rs` | Inline | Yes | enum of Primitives |
| `SceneChunk` | `scene/chunk.rs` | Inline | Yes | EntityId + ranges |
| `ChangedRanges` | `scene/chunk.rs` | Vecs of Range | Yes | |

### wgpu Type Thread Safety

| Type | Send | Sync | Constraint |
|---|---|---|---|
| `wgpu::Queue` | Yes | Yes | Thread-safe internally (uses Mutex) |
| `wgpu::Device` | Yes | Yes | Thread-safe internally |
| `wgpu::Texture` | Yes | Yes | Can be shared via Arc |
| `wgpu::TextureView` | Yes | Yes | |
| `wgpu::CommandEncoder` | Uncertain | Uncertain | Depends on wgpu version |
| `wgpu::CommandBuffer` | Yes | Yes | |
| `wgpu::Surface` | **No** | No | Must stay on creating thread |
| `wgpu::BindGroup` | Yes | Yes | |
| `wgpu::Pipeline` | Yes | Yes | |
| `wgpu::Sampler` | Yes | Yes | |

The key enabling fact is that `wgpu::Queue` is `Send + Sync`. We clone the queue (it's internally `Arc<QueueInner>`) and give the clone to the compositor thread. All `queue.write_buffer()` and `queue.submit()` calls happen on the compositor thread. The main thread's queue clone is used only for the blit submission. Since `Queue::submit()` uses internal synchronization, concurrent submissions from two threads are safe and correctly ordered.

The question mark on `CommandEncoder` is the one piece we haven't fully verified. Modern wgpu (the `Far-Beyond-Pulsar/wgpu` fork at commit `fce5b80`) may have made `CommandEncoder` `Send + Sync`. If it hasn't, the compositor creates the encoder and submits within the same function on the compositor thread — the encoder never crosses threads. The `CommandBuffer` resulting from `encoder.finish()` is `Send + Sync` and can be moved between threads. In the worst case — if `CommandEncoder` is `!Send` — the design still works: the compositor creates the encoder, records commands, calls `encoder.finish()`, and submits the resulting buffer. No thread crossing needed.

---

## The Fallback Path: When the Compositor Isn't Available

Not every GPUI deployment will have a compositor thread. The test platform (`TestPlatform`) doesn't have a real GPU, so there's no compositor. The WebGPU target may not support the overscroll buffer's memory requirements. The compositor thread could fail to spawn. The user might set `GPUI_COMPOSITOR_DISABLED=1` for debugging.

For all of these cases, the framework falls back to synchronous rendering — the same path it uses today. The fallback is not an afterthought. It's compiled, tested, and maintained alongside the compositor path.

The fallback is triggered by the absence of a compositor handle:

```rust
impl Window {
    fn draw(&mut self, cx: &mut App) -> ArenaClearNeeded {
        // ... existing preamble ...
        self.draw_roots(cx);
        // ... existing bookkeeping ...

        if let Some(compositor) = self.compositor.as_ref() {
            let scene = std::mem::take(&mut self.next_frame.scene);
            let previous = std::mem::take(&mut self.rendered_frame.scene);

            match compositor.commit_tx.try_send(CompositorJob::Commit {
                scene,
                overscroll_origin: self.overscroll_origin(),
            }) {
                Ok(()) => {
                    self.rendered_frame.scene = previous;
                }
                Err(TrySendError::Full(scene)) => {
                    // Compositor busy — fall back to synchronous
                    self.fallback_finish_and_swap(scene, previous);
                }
                Err(TrySendError::Disconnected(_)) => {
                    // Compositor crashed — fall back permanently
                    self.compositor = None;
                    self.fallback_finish_and_swap(scene, previous);
                }
            }
        } else {
            // No compositor — synchronous rendering
            self.next_frame.finish(&mut self.rendered_frame);
            // ... continue with swap, upload, present as before
        }

        // ... continue with focus tracking, entity recording ...
    }
}
```

The `TestPlatform` never creates a compositor, so all tests run through the synchronous fallback. This ensures test behavior doesn't depend on threading.

The persistent framebuffer that already exists in GPUI serves double duty in this architecture. When the compositor is busy or the overscroll buffer doesn't cover the viewport, `present_framebuffer_only()` shows the last fully-rendered frame. This is the same path that currently handles the "no changes since last frame" case — it just blits the persistent framebuffer to the swapchain without any compositor work.

When we started this design, we considered making the compositor required — if it fails to spawn, crash. We changed our minds after thinking about the test platform, the WebGPU target, and the debugging use case. Every code path in the compositor architecture has a synchronous fallback. The fallback is tested in CI. It's slower, but it works, and it means the compositor is an optimization rather than a dependency.

---

## What We're Still Figuring Out

The design is complete enough to describe, but there are open questions we haven't resolved.

### How Do We Handle Variable-Height Content?

This is the biggest unresolved question. The overscroll buffer is correct when content heights are stable between scroll events — the cached pixels remain valid because nothing moved except the viewport. But if an element above the viewport changes height, every element below it shifts, and the overscroll buffer's content is now wrong.

There are three approaches we're considering:

**Approach 1: Require the stable-height contract explicitly.** Scroll containers that want the overscroll fast path must declare that their content has stable heights. `List` and `UniformList` already require this — the overscroll buffer would be enabled for them by default, disabled for generic scrollable `div` elements unless the application opts in. This is the honest approach: it tells the user what the optimization requires and lets them decide.

**Approach 2: Detect height changes automatically.** The scene finish phase already computes damage rectangles. If the damage rect from a content change doesn't intersect the scrolled area's stable region, the overscroll buffer is valid. If it does intersect, the buffer is invalidated and re-rendered. This is what browsers do, and it works because tile-level dirty tracking catches the mismatch. The complexity is in tracking which tiles are affected by a layout change.

**Approach 3: Never invalidate, just re-render the affected tile on the next scroll.** If the user scrolls and the blit would read from a stale tile, the compositor re-renders that tile before blitting. The main thread doesn't need to know about height changes — it just commits when content changes, and the compositor figures out what needs updating.

Our current leaning is a combination of 1 and 2: the stable-height contract is required for the GPU-level fast path, but the compositor also has a tile-versioning system that detects stale content and triggers re-render for containers that don't explicitly opt out.

### How Do Scroll Containers Opt In?

The separation of scroll from content requires scroll containers to change their behavior. Currently they call `cx.notify()`. We want them to call something that doesn't trigger a full re-render.

Option A: A new method on `Window` — `window.record_scroll(offset)` — that updates scroll state without a commit. Scroll containers call this instead of `cx.notify()` when only the offset changed. This requires modifying every scroll container in the framework and every custom scroll container in application code.

Option B: Automatic detection in the window's event handler. The window tracks which views were notified during scroll event dispatch. If only scroll-related views were notified, the window treats it as a scroll-only event. No API change needed, but the detection heuristic may have false negatives or false positives.

We're leaning toward Option A with a fallback to Option B for containers that haven't been updated. The `cx.notify()` path still works — it just triggers a full commit instead of a fast scroll blit. Applications get the performance benefit when they opt in, and correct (but slower) behavior otherwise.

The hardest part is the scroll container API change. Everything in the compositor design is a backend concern — new files, new threads, new GPU resources. The scroll container change is a frontend concern that affects every element tree that implements scrolling. It's a breaking change (for the efficient path), and it requires educating framework users about the new pattern. The bright spot is that `List` and `UniformList` already have the stable-height contract baked into their API — they're natural early adopters and will see the largest perf improvement from the overscroll buffer with minimal internal changes.

### What About Animations That Affect Position?

Smooth-scroll animations that interpolate scroll offset across multiple frames should ideally use the overscroll fast path — updating the scroll offset each frame without a commit, with the blit origin smoothly tracking the animated offset. This requires the animation system to distinguish "position animation" from "property animation" and route them differently. We haven't designed this yet, but it's a natural extension once the basic scroll separation is in place.

## In Short

GPUI's current architecture renders every frame from scratch, on the main thread, regardless of what changed. For a complex UI, the main thread is occupied for a substantial fraction of the frame budget with work that doesn't need to be there. Every scroll pixel costs the same as a full content edit.

The compositor thread architecture we've described here changes the dynamics completely. The main thread's per-frame work drops to roughly the element tree cost, with the finish and upload phases running in parallel on a dedicated compositor thread. The overscroll buffer makes scrolling nearly free — no element tree traversal, no sorting, no uploading, no encoding — just a GPU blit with an offset.

For a user scrolling through a 10,000-line file or a project panel with thousands of entries, the difference is the difference between stuttering through every scroll event and scrolling at a locked 120fps. For an application that needs to maintain responsiveness during rendering, the difference is the difference between a blocked event loop and instant input response.

We're building this now. The code doesn't exist yet — this post is the design we're working toward, not the code we've shipped. As the phases are implemented, we'll post follow-ups with profiling data, edge cases we missed, and the inevitable design changes that come from actually running the code.

The compositor module will live in the WGPUI repository at `src/gpui/platform/cross/compositor.rs` when it exists. If this architecture looks like something you'd approach differently — or if you've already solved the same problem and found a better way — we'd genuinely like to hear about it.
