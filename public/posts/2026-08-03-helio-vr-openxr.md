---
title: "Helio VR: OpenXR Integration Through wgpu's Vulkan Escape Hatch"
date: "2026-08-03"
author: ["tristanpoland"]
tags: ["rust", "helio", "graphics", "vr", "openxr", "vulkan", "architecture", "pulsar"]
description: "How Helio drives an HMD through OpenXR — Vulkan instance and device created through the runtime, dual-pass stereo rendering through existing forward pipelines, asymmetric-FOV camera math with a documented clip-space bug, controller input across four interaction profiles, and a PC mirror blit that shows both eyes side by side."
thumbnail: /post_thumb/vr2.png
---

Helio's renderer was built for flat screens. Single camera, deferred shading, temporal accumulation, shadow cascades, foliage, water, post-processing. Fifty passes wired into a graph targeting one `wgpu::TextureView` at your monitor's resolution. VR meant the same pipeline had to render two views at 90 Hz with asymmetric per-eye frustums. Controller input through a runtime that owns your GPU device. A swapchain whose images you cannot free.

The principle was straightforward: activate the existing forward-capable pipeline in stereo mode. `RendererConfig::enable_xr` flips a flag at build time. The graph executor injects `multiview_mask = 0b11` on every render pass. The texture pool allocates internal targets as 2-layer `D2Array` textures. The camera storage buffer grows from one slot to two. Every shader, every post-effect, every draw call works unchanged. The same `submit_frame` call with a different texture view.

Building that bridge meant reaching into wgpu and extracting raw Vulkan handles. OpenXR expects `VkInstance`, `VkPhysicalDevice`, `VkDevice`, `VkImage`. It insists on creating them itself through `xrCreateVulkanInstanceKHR` and `xrCreateVulkanDeviceKHR`. The runtime injects its own extensions and picks the physical device the HMD is driven by. On a laptop with integrated and discrete GPUs, the runtime picks the discrete one. You cannot create your own `VkInstance` and hand it to OpenXR. The runtime rejects it.

Every handle came out through `as_hal::<Vulkan>()`. Every wrapped handle went back through `Instance::from_raw`, `expose_adapter`, `device_from_raw`, and `create_device_from_hal`. Every one of those calls is `unsafe`. Every one is pinned to the exact wgpu 30.0.0 hal API surface. The boundary is thin, version-sensitive, and cannot be tested without a headset.

---

## The Hal Escape Hatch

wgpu-hal is the internal backend abstraction layer that wgpu's safe API sits on top of. Normally an application never touches it. The XR path bypasses `wgpu::Instance::new()` entirely.

The instance creation in `context.rs:create_wgpu_instance` starts by querying wgpu-hal for the Vulkan extensions it needs:

```rust
let extensions =
    <Vulkan as Api>::Instance::desired_extensions(&vk_entry, vk_target_version, flags)
        .map_err(|e| XrError::Platform(format!("wgpu-hal desired_extensions: {e}")))?;
let extensions_cchar: Vec<_> = extensions.iter().map(|s| s.as_ptr()).collect();
```

`desired_extensions` returns wgpu-hal's list: `VK_KHR_surface`, `VK_KHR_win32_surface` (or the platform equivalent), debug extensions, and the timeline semaphore extension. These are the exact extensions wgpu expects to be present on a normal `VkInstance`. We build a `VkInstanceCreateInfo` from them and pass the pointer to OpenXR.

The `get_instance_proc_addr` transmute sits at the boundary:

```rust
let get_instance_proc_addr = unsafe {
    std::mem::transmute::<
        ash::vk::PFN_vkGetInstanceProcAddr,
        openxr::sys::platform::VkGetInstanceProcAddr,
    >(vk_entry.static_fn().get_instance_proc_addr)
};
```

Both `ash` and `openxr::sys` define this function pointer type. They define it as separate types. The ABI is identical, the raw `PFN_vkVoidFunction (*)(VkInstance, const char*)` from the Vulkan header, but Rust treats them as incompatible. The `transmute` asserts they are layout-identical. If ash ever changes its function pointer ABI this breaks silently.

OpenXR merges its own required extensions into the `VkInstanceCreateInfo`: `VK_KHR_external_memory_capabilities`, `VK_KHR_get_physical_device_properties2`, the platform-specific surface extension for the compositor, and debug utils if available. The resulting `VkInstance` is wrapped back into wgpu through `from_raw`:

```rust
let hal_instance = unsafe {
    <Vulkan as Api>::Instance::from_raw(
        vk_entry, vk_instance, vk_target_version, 0,
        None, extensions, flags,
        MemoryBudgetThresholds::default(), false, None,
    )
};
```

The `from_raw` call takes ownership of the `VkInstance`. It treats it as if wgpu-hal had created it. wgpu's resource tracker, its deferred barrier logic, its allocation pools all operate on an instance whose creation they did not control. If OpenXR injected an extension wgpu does not know about, `from_raw` returns an error.

The device path is deeper. The physical device comes from OpenXR:

```rust
let vk_physical_device = unsafe {
    xr_instance.vulkan_graphics_device(xr_system, raw_instance.handle().as_raw() as _)
};
```

This is `xrGetVulkanGraphicsDevice2KHR`. The runtime knows which GPU the HMD is connected to. On a laptop with integrated and discrete GPUs, the runtime returns the discrete one. The function takes the raw `VkInstance` handle cast to a `u64`, the same instance we just created through OpenXR.

The HAL adapter is exposed through `expose_adapter`:

```rust
let hal_adapter = hal_instance
    .expose_adapter(vk_physical_device)
    .ok_or_else(|| ...)?;
```

This asks wgpu-hal to wrap the `VkPhysicalDevice` in its internal `ExposedAdapter` struct, which carries the device's feature set, limits, and wgpu-hal's own adapter object. The feature set is masked against what the application requested. `Features::MULTIVIEW` is required and the function fails if the HMD does not support it.

The logical device is created through OpenXR, then wrapped with `device_from_raw`:

```rust
let vk_device = unsafe {
    xr_instance.create_vulkan_device(
        xr_system,
        get_instance_proc_addr,
        vk_physical_device.as_raw() as _,
        &device_info as *const _ as *const _,
    )
};
let hal_device = unsafe {
    hal_adapter.adapter.device_from_raw(
        vk_device,
        None,                           // render-bundle cache
        &device_extensions,
        required_features,
        &limits,
        &memory_hints,
        queue_family_index,
        0,                              // queue index
    )
};
```

The `None` render-bundle cache is worth noting. wgpu-hal normally creates a `RenderBundleCache` alongside the device for acceleration structure encoding. Passing `None` disables it. The XR device path does not use render bundles, so there is no hit.

`create_device_from_hal` wraps the hal device into a full `wgpu::Device` with a `Queue`:

```rust
let (device, queue) =
    unsafe { wgpu_adapter.create_device_from_hal(hal_device, &device_desc) }
        .map_err(|e| ...)?;
```

The `device_desc` carries the limits separately because this path bypasses `request_device` entirely. The limits must be rebuilt from the HAL adapter's capabilities rather than going through wgpu's normal limit negotiation.

---

## Limits Negotiation When OpenXR Owns the Device

`request_device` does not get called. OpenXR owns the `VkDevice`, so wgpu's normal device creation pipeline where it validates limits against the adapter and negotiates them down is replaced entirely. The limits are built in `create_wgpu_device` from `hal_adapter.capabilities.limits`:

```rust
let mut limits = hal_adapter.capabilities.limits.clone();
limits.max_sampled_textures_per_shader_stage
    = limits.max_sampled_textures_per_shader_stage.min(MAX_TEXTURES as u32);
limits.max_multiview_view_count = limits.max_multiview_view_count.max(2);
limits.max_buffer_size = limits.max_buffer_size.min(u32::MAX as u64);
```

The `max_sampled_textures` cap at 256 mirrors Helio's bindless texture table limit. The `max_multiview_view_count = max(2)` ensures multiview can address both eyes even if the adapter reports a lower default.

The `max_buffer_size` cap exists because wgpu-core asserts `max_buffer_size <= u32::MAX` at `wgpu-core/src/indirect_validation/draw.rs:72`. An RTX 4090 reports 16 GiB of addressable buffer. That assertion panics at device creation:

```
wgpu-core/src/indirect_validation/draw.rs:72: ... assertion failed
```

The error surfaces on the XR path only, because the normal `request_device` path applies its own clamping. The fix is the `min(u32::MAX as u64)` on line 186. Without it, the device creation panics before the first frame and the symptom is "VR is broken" rather than "limits problem."

The normal `helio::required_wgpu_limits` function is not called. The limits code in `context.rs` duplicates those caps explicitly, and the comment at line 177 warns that any future limit change must be mirrored here. There is no shared function.

---

## The Graphics Trait and Why It Exists

The `openxr` crate ships a `vulkan` module implementing its `Graphics` trait. It has the right associated types: `Format = u32` (VkFormat) and `SwapchainImage = u64` (VkImage handle). But it is generic over `openxr::Swapchain<openxr::vulkan::Vulkan>`, and Helio's swapchain is `Swapchain<WgpuGraphics>`.

`WgpuGraphics` at `graphics.rs:25` is a zero-sized marker type. It delegates every `Graphics` trait method to the built-in `openxr::vulkan::Vulkan` implementation except `enumerate_swapchain_images`:

```rust
impl Graphics for WgpuGraphics {
    type Requirements = <openxr::vulkan::Vulkan as Graphics>::Requirements;
    type SessionCreateInfo = <openxr::vulkan::Vulkan as Graphics>::SessionCreateInfo;
    type Format = <openxr::vulkan::Vulkan as Graphics>::Format;
    type SwapchainImage = <openxr::vulkan::Vulkan as Graphics>::SwapchainImage;
    // ... forward to built-in ...
}
```

The only method that differs is `enumerate_swapchain_images`. The built-in one calls `xrEnumerateSwapchainImages` through the `openxr::vulkan::Vulkan` vtable, which returns `SwapchainImageVulkanKHR` structs. But `Swapchain<WgpuGraphics>` has a different `PhantomData` than `Swapchain<openxr::vulkan::Vulkan>`, and the built-in method only implements the generic for the latter. Re-implementing `enumerate_swapchain_images` means calling the raw `fp.enumerate_swapchain_images` function pointer directly, enumerating into a `Vec<SwapchainImageVulkanKHR>`, and extracting the `image: u64` handle from each:

```rust
fn enumerate_swapchain_images(
    swapchain: &openxr::Swapchain<Self>,
) -> openxr::Result<Vec<Self::SwapchainImage>> {
    let fp = swapchain.instance().fp();
    let mut count = 0u32;
    unsafe {
        (fp.enumerate_swapchain_images)(
            swapchain.as_raw(), count, &mut count, std::ptr::null_mut()
        )
    };
    let mut buf = vec![SwapchainImageVulkanKHR { ty: TYPE, next: null_mut(), image: 0 }; count as usize];
    unsafe {
        (fp.enumerate_swapchain_images)(
            swapchain.as_raw(), count, &mut count, buf.as_mut_ptr() as *mut _
        )
    };
    Ok(buf.into_iter().map(|x| x.image).collect())
}
```

The alternative would be to use `openxr::vulkan::Vulkan` throughout and cast the swapchain handle at the call sites. But that leaks the PhantomData mismatch into every function that touches the swapchain. The newtype isolates the mismatch in one place.

---

## Wrapping OpenXR Swapchain Images

OpenXR allocates the swapchain images and owns their memory. Each `acquire_image` returns an index into a fixed pool of `VkImage` handles that are stable for the swapchain's lifetime. The images are enumerated once at startup and wrapped into wgpu textures.

`wrap_vk_image` at `swapchain.rs:198` takes a raw `u64` handle, creates a `wgpu::TextureDescriptor` matching the swapchain's dimensions and format, builds a hal-level `TextureDescriptor`, and calls `hal_device.texture_from_raw`:

```rust
let hal_texture = unsafe {
    hal_device.texture_from_raw(
        ash::vk::Image::from_raw(raw_image),
        &hal_descriptor,
        Some(Box::new(|| {})),   // no-op drop callback
        TextureMemory::External,
    )
};
```

`TextureMemory::External` tells wgpu-hal that the image's backing memory is not owned by wgpu and must never be freed. The no-op drop callback means the hal texture wrapper can be dropped without side effects. If wgpu tries to destroy this texture through its normal lifecycle, a graph rebuild or `Renderer` drop, the no-op callback prevents the `VkImage` from being freed. OpenXR owns the image. OpenXR returns it to the runtime's pool on `release_image`.

The wgpu texture is created with `TextureUses::UNINITIALIZED`:

```rust
let texture = unsafe {
    device.create_texture_from_hal::<Api>(
        hal_texture, &descriptor,
        wgpu::wgt::TextureUses::UNINITIALIZED,
    )
};
```

`UNINITIALIZED` tells wgpu's resource tracker that the image's contents and layout are unknown. On `acquire_image`, the runtime may have transitioned the image to `VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL` or `VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL` or any other layout. wgpu's tracker emits the first barrier as a legal discard, from `VK_IMAGE_LAYOUT_UNDEFINED` to the layout the first render pass expects, without validating the previous state. Using `UNINITIALIZED` instead of a known initial layout avoids a tracker assertion when the runtime's layout does not match wgpu's expectation.

Two views are created per image. A `D2Array` view for the swapchain array render target and per-layer `D2` views for per-eye rendering:

```rust
let view = texture.create_view(&wgpu::TextureViewDescriptor {
    dimension: Some(wgpu::TextureViewDimension::D2Array),
    array_layer_count: Some(array_size),
    ..Default::default()
});
for layer in 0..array_size {
    layer_views.push(texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2),
        base_array_layer: layer,
        array_layer_count: Some(1),
        ..Default::default()
    }));
}
```

The array views are what the multiview code path will use. The layer views are what the current dual-pass path uses, passing one eye's layer to each `submit_frame` call.

The 2-layer swapchain is requested first. If the runtime rejects it, SteamVR on some driver versions or older Oculus runtimes, the fallback creates a 1-layer swapchain and `sub_image_rect` splits the image width between the two eyes:

```rust
let swapchain = match session.create_swapchain(&swapchain_info(vk_format, width, height, 2)) {
    Ok(swapchain) => swapchain,
    Err(first) => {
        log::warn!("runtime rejected a 2-layer swapchain ({first}); retrying with 1 layer");
        let swapchain = session.create_swapchain(&swapchain_info(vk_format, width, height, 1))?;
        array_size = 1;
        swapchain
    }
};
```

Format negotiation maps between wgpu's `TextureFormat` and Vulkan's `VkFormat` numeric values. The mapping is a direct switch on known formats: `Rgba8UnormSrgb` is `VK_FORMAT_R8G8B8A8_SRGB` (numeric value 43), `Bgra8UnormSrgb` is 50, `Rgba16Float` is 97. If the requested format is not in the runtime's advertised list, the code falls back to the first runtime format it knows how to wrap.

---

## The Session Create Info Extraction

`vulkan_session_create_info` in `session.rs:338` extracts raw Vulkan handles from wgpu and describes them in the form OpenXR expects:

```rust
pub fn vulkan_session_create_info(device: &wgpu::Device) -> Result<openxr::vulkan::SessionCreateInfo> {
    let hal_device = unsafe { device.as_hal::<wgpu::hal::vulkan::Api>() }
        .ok_or_else(|| XrError::GraphicsUnavailable(...))?;

    let instance = hal_device.shared_instance().raw_instance().handle().as_raw()
        as *const std::ffi::c_void;
    let physical_device = hal_device.raw_physical_device().as_raw()
        as *const std::ffi::c_void;
    let device = hal_device.raw_device().handle().as_raw()
        as *const std::ffi::c_void;

    Ok(openxr::vulkan::SessionCreateInfo {
        instance, physical_device, device,
        queue_family_index: hal_device.queue_family_index(),
        queue_index: hal_device.queue_index(),
    })
}
```

`raw_instance()` returns the `ash::Instance`. `raw_physical_device()` returns the `vk::PhysicalDevice`. `raw_device()` returns the `vk::Device`. Each handle is cast to `*const c_void`, the raw pointer form OpenXR's C API expects. The `queue_family_index` and `queue_index` are queried from wgpu-hal's device. They were recorded at its own `device_from_raw` call.

The session is created with a guard that keeps the wgpu `Instance` and `Device` alive for the session's lifetime. Without the guard, dropping the `Renderer` would destroy the underlying Vulkan device before the session does:

```rust
let guard = Box::new((wgpu_instance.clone(), device.clone()));
let (session, frame_waiter, frame_stream) = unsafe {
    instance.create_session_with_guard::<WgpuGraphics>(system, &create_info, guard)?
};
```

The signature pattern, `create_session_with_guard` taking a `Box<dyn Any>`, is OpenXR's mechanism for associating user data with the session. The box is leaked to the runtime and freed when the session is destroyed. Without the guard, `Renderer::drop` would destroy the `VkDevice` while OpenXR still held references to it. That is a use-after-free.

---

## The Renderer's XR State

The `Renderer` struct at `renderer_impl.rs:64` carries XR-specific fields behind `#[cfg(not(target_arch = "wasm32"))]`:

```rust
pub(crate) xr_stage_transform: glam::Mat4,        // locomotion hook
pub(crate) enable_xr: bool,                        // preserved across graph rebuilds
pub(crate) xr_instance: Option<helio_xr::XrInstance>,
pub(crate) xr: Option<helio_xr::XrSession>,
pub(crate) xr_swapchain: Option<helio_xr::XrSwapchain>,
pub(crate) xr_depth_texture: Option<wgpu::Texture>,     // 2-layer Depth32Float
pub(crate) xr_depth_view: Option<wgpu::TextureView>,    // D2Array
pub(crate) xr_depth_view_layer0: Option<wgpu::TextureView>, // D2 for sampling passes
pub(crate) xr_mirror_pipeline: Option<wgpu::RenderPipeline>,
pub(crate) xr_mirror_bgl: Option<wgpu::BindGroupLayout>,
pub(crate) xr_mirror_sampler: Option<wgpu::Sampler>,
pub(crate) xr_mirror_bind_group: Option<(u32, wgpu::BindGroup)>,
pub(crate) xr_mirror_format: Option<wgpu::TextureFormat>,
```

`xr_depth_texture` is a `Depth32Float` 2-layer array created by `create_xr_depth_resources` in `setup.rs:48`. It is the depth-stencil attachment for the multiview render pass. A `D2Array` view is the target the graph executor binds when `multiview_mask = 0b11`. A separate `D2` view of layer 0 is provided for passes that sample depth as a plain `texture_depth_2d`. HiZ construction, lens flare, and SSAO all need this. A `D2Array` view cannot be bound to a `D2` bind-group entry.

`xr_mirror_bind_group` is cached per swapchain image index. The key `(u32, BindGroup)` lets the blit reuse the bind group across frames for the same image index, rebuilding only when the acquired image changes:

```rust
if self.xr_mirror_bind_group.as_ref().map(|(k, _)| *k) != Some(image_index) {
    let bg = self.device.create_bind_group(...);
    self.xr_mirror_bind_group = Some((image_index, bg));
}
```

The mirror pipeline is lazily created and cached. It is keyed on the mirror surface's colour format, set by `set_xr_mirror_format` and typically `Bgra8UnormSrgb` on Windows. When the format changes, a monitor resolution change or a window move between displays with different pixel formats, the pipeline is dropped and rebuilt on the next `blit_xr_to_mirror` call.

---

## The Render Loop

`Renderer::render_xr()` at `render.rs:675` drives the XR frame lifecycle in six phases.

Phase one pumps OpenXR events. `session.poll_events()` drives the state machine. `SessionEvent::Exit` and `LossPending` return early. If `session_begun` is false, the runtime has accepted `xrBeginSession` but the session has not yet reached `SYNCHRONIZED`, the function sleeps 10 ms and returns. Rate-limited logging suppresses the "session not begun" message to once per 60 skips.

Phase two calls `wait_frame()` and `begin_frame()`. The OpenXR frame lifecycle contract is strict. Every `wait_frame` must pair with `begin_frame`. Every frame must end with `end_frame` whether the runtime asked the app to render or not. Skipping `begin_frame` causes the next `wait_frame` to block indefinitely.

Phase three locates the per-eye views. `session.locate_views(display_time, &stage_transform)` returns a `LocatedViews` with raw OpenXR views in stage space and `ViewPose` values transformed into engine world space. The `world_from_stage` matrix is the locomotion hook. It starts as identity. Joystick input modifies it, translating and rotating. The scene content stays in world space. The player moves the stage-space anchor instead.

Phase four acquires one swapchain image and renders both eyes into it sequentially. Each eye gets its own `GpuCameraUniforms`, its own representative camera, its own debug camera buffer, and its own layer view from the swapchain. `submit_frame` is called once per eye with `multiview = false`:

```rust
let image_index = swapchain.acquire_image()?;
for (eye, pose) in located.view_poses.iter().enumerate() {
    let eye_uniform = helio_xr::xr_view_to_camera(pose, pose, near_far.0, near_far.1)[0];
    self.scene.update_stereo_cameras(&eye_uniform, &eye_uniform);
    self.scene.flush();
    representative = /* per-eye camera from template */;
    // per-eye debug camera buffer upload
    let layer_view = swapchain.layer_view(image_index, eye as u32)?;
    self.submit_frame(&representative, &layer_view, false)?;
}
```

`update_stereo_cameras` writes both camera slots to the same value. Shaders sample `cameras[0]` exclusively in the current dual-pass path, so only the first slot is consumed. Writing both avoids stale data in slot 1 when a future multiview path reads it.

Phase five blits the swapchain image to the PC mirror. A fullscreen triangle samples the 2-layer array texture. Eye 0 fills the left half of the window. Eye 1 fills the right half. The shader splits UV at `x = 0.5` and selects the layer based on the half.

Phase six presents the swapchain and ends the frame:

```rust
swapchain.present()?;
session.end_frame(display_time, swapchain, &located.views)?;
```

`end_frame` takes the raw stage-space views, not the world-space `ViewPose` values. The composition layer is anchored to the stage space, and the runtime uses the pose and FOV from each view to position the eye buffers in the compositor's display.

---

## The Projection Matrix Bug

OpenXR reports per-eye FOV as four asymmetric half-angles: `angle_left`, `angle_right`, `angle_up`, `angle_down`. The frustum is off-centre because the eye socket sits to the left of the HMD's centreline for the left eye and to the right for the right eye. The projection matrix must capture that asymmetry for stereo fusion to work.

The bug at `camera.rs:97` was two mistakes in one function.

Mistake one: wgpu uses D3D/Vulkan clip space with Z in [0, 1]. The original code used the OpenGL [-1, 1] form:

```
m22 = -(far + near) / (far - near)
translate = -2 * far * near / (far - near)
```

This maps the near half of the frustum to negative Z. Everything there fails the `0 ≤ z ≤ w` clip test and vanishes. The world clips at what appears to be a much closer distance than the near plane. The compute shader that builds the prelude for the rasteriser also maps to [0,1], so the mismatch affects only the XR path and presents as an HMD-specific bug.

Mistake two: `from_cols_array` expects column-major order with indices 0-3 for column 0, 4-7 for column 1, 8-11 for column 2, and 12-15 for column 3. Index 11 is `col2.w` and index 14 is `col3.z`. The perspective divide term `-1` belongs in index 11 and the depth translate belongs in index 14. They were swapped. A symmetric frustum hides this because the shear is symmetric. An asymmetric OpenXR frustum amplifies it: the left column is in the wrong slot, so the off-centre offset is mirrored across the vertical axis. Eye 0's NDC centre shifts right while eye 1's shifts right by the same amount instead of left. The two frustums refuse to fuse. Black wedges appear in opposite corners.

The corrected code:

```rust
glam::Mat4::from_cols_array(&[
    m00, 0.0, 0.0, 0.0,       // col 0
    0.0, m11, 0.0, 0.0,       // col 1
    m20, m21, m22, -1.0,      // col 2, divide in col2.w
    0.0, 0.0, depth_translate, 0.0,  // col 3, translate in col3.z
])
```

Three tests in the same file pin the fix. `depth_maps_zero_to_one_not_minus_one_to_one` confirms near plane maps to Z = 0, far plane to Z = 1, and the midpoint is inside [0,1]. `symmetric_fov_matches_glams_perspective` compares element-by-element against `glam::Mat4::perspective_rh`. `asymmetric_fov_is_off_centre_in_the_expected_direction` verifies that a lopsided frustum with `angle_left = -1.0` and `angle_right = 0.6` shifts the view axis to `x > 0` in NDC, and that the mirrored frustum produces a mirrored NDC centre with the same magnitude.

---

## The XR Mirror Blit

`blit_xr_to_mirror` at `render.rs:892` draws both eyes side by side into a window surface. The shader is a fullscreen triangle defined inline as WGSL:

```wgsl
@vertex
fn vs_fullscreen(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    let pos = array(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
    return vec4(pos[vi], 0.0, 1.0);
}

@fragment
fn fs_mirror(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = pos.xy / vec2<f32>(f32(OUTPUT_W), f32(OUTPUT_H));
    let layer = select(1u, 0u, uv.x < 0.5);
    let sample_uv = vec2(uv.x * 2.0 - select(0.0, 1.0, uv.x >= 0.5), uv.y);
    return textureSample(xr_swapchain, samp, sample_uv, i32(layer));
}
```

The inline WGSL uses a constant `OUTPUT_W` and `OUTPUT_H` that are baked into the shader string at pipeline creation time. `select(1u, 0u, uv.x < 0.5)` picks the left half for layer 0 and right half for layer 1. The sample UV remaps each half to the full [0,1] range.

The pipeline is lazily created and cached on the `Renderer`. It is rebuilt when the mirror surface format changes. The bind group is cached per swapchain image index. Pipeline, bind group layout, sampler, and the bind group keyed on image index are all lazy-allocated. None of them are touched when the mirror is not active.

---

## Controller Input

`XrInput` at `input.rs:55` declares four actions before the session is created: `move` (left stick), `turn` (right stick), `select` (button A / left trigger click), and `grip` (grip pose). Action declarations must happen before session creation. OpenXR's rule: actions are part of the session's immutable definition. Deducing a runtime does not have a profile yet.

Four interaction profiles are suggested:

| Profile | Left stick | Right stick | Click | Grip pose |
|---|---|---|---|---|
| Oculus Touch | thumbstick | thumbstick | /input/a/click | /input/grip/pose |
| Valve Index | thumbstick | thumbstick | /input/a/click | /input/grip/pose |
| MS Motion Controller | thumbstick | thumbstick | /input/trigger/value | /input/grip/pose |
| KHR Simple Controller | — | — | /input/select/click | — |

Each profile's bindings are constructed separately. A runtime that does not know a profile path fails the `string_to_path` call, and that profile is skipped with a `continue`. `suggest_interaction_profile_bindings` for the skipped profile is never called. Without this, an unknown headset profile would abort input setup for every headset.

`attach()` is called exactly once after session creation. A second call fails. `sync()` reads the action states per frame. When the session is not focused, the runtime reports actions as inactive and the function returns `ControllerState::default()` with all-zero sticks and `select = false`. This prevents the player from drifting while a system menu or overlay is visible.

Grip pose matrices are located through lazily-created action spaces. On the first `grip_pose_matrices` call, the system creates one `Space` per hand from the `grip` action and a STAGE reference space. Subsequent calls perform two `locate_space` calls per frame:

```rust
for (i, space) in spaces.iter().enumerate() {
    if let Ok(location) = space.locate(stage, time) {
        if location_flags contains POSITION_VALID && ORIENTATION_VALID {
            out[i] = Some(*world_from_stage * pose_to_mat4(&location.pose));
        }
    }
}
```

`pose_to_mat4` converts the OpenXR `Posef`, a quaternion and translation, into a `glam::Mat4`. OpenXR stores quaternions as (x, y, z, w) and glam uses the same convention. The returned matrix is `world_from_stage * stage_from_grip`, so the controller follows the player's locomotion. `None` means the hand is not tracked. Controller off, session not focused, action not yet bound. Callers keep the previous transform instead of snapping.

---

## The Demo

`examples/vr/main.rs` is a dual-path application. `try_init_xr()` attempts the full bootstrap sequence: load the OpenXR entry point, create the instance, create the wgpu instance and device through OpenXR, create the session and swapchain. If any step fails, no headset or no loader or a Vulkan mismatch, the demo falls back to plain wgpu on the default GPU with WASD and mouse free-cam.

The scene is a 9-bay showcase hallway at human scale. 3-metre ceiling, 4.8-metre width, 8 metres per bay. PBR materials, spot lights, lens flare, volumetric fog, water simulation, GPU particles, emissive/HDR objects, virtual geometry, and colour grading. The same scene renders identically through the headset and the desktop mirror. Eye height is 1.6 metres.

Controller support follows the action system. Left stick moves through the world by updating `xr_stage_transform`. Right stick turns. Grip pose tracks each hand. A cube is parented to each controller's grip pose matrix so the user can see their hands.

Two other demos share the same pattern. `foliage_demo.rs` and `vhs_backrooms.rs` both call `try_init_xr()` and fall back to flat rendering. XR is best-effort at every level.

---

## The Unsafe Surface Area

Every function in the XR bridge is explicitly marked `unsafe` or calls `unsafe` internally. The `lib.rs` module doc comment states the contract:

> The `openxr` crate has no built-in wgpu module, so `graphics` implements `openxr::Graphics` against the raw Vulkan handles extracted through wgpu's `as_hal()` escape hatch and wgpu-hal's `texture_from_raw`. Both are inherently `unsafe`, backend-specific (Vulkan), and wgpu-version specific.

The concrete unsafe operations are:

- `transmute` of `get_instance_proc_addr` between ash and OpenXR function pointer types. ABI-compatible today. Not guaranteed by any spec.
- `from_raw` on `ash::Instance`, `ash::Device`, `vk::PhysicalDevice`, `vk::Image`. Takes a raw handle and assumes it is valid and fully initialised.
- `Instance::from_hal`, `create_adapter_from_hal`, `device_from_raw`, `create_device_from_hal`. These are wgpu-hal's escape hatches that take backends created externally and wrap them. The calling code must ensure the supplied limits match the device's actual capabilities.
- `texture_from_raw` with `TextureMemory::External`. The no-op drop callback prevents wgpu from freeing OpenXR-owned memory. If the callback were anything other than no-op, or if `TextureMemory` were anything other than `External`, the runtime would crash on `release_image`.
- `create_session_with_guard`. The guard is leaked to the C side and held for the session's lifetime. If Rust moves or drops the session before the runtime releases it, the guard's destructor may run while OpenXR still holds the pointer.

---

## Dual-Pass and the Multiview Gap

The renderer uses dual-pass stereo. Each eye renders through the full forward pipeline. `multiview_mask = 0b11` is injected at every render pass creation—`GraphTexturePool::set_xr_mode(true)` allocates all internal targets as 2-layer `D2Array` textures—but the shaders sample `cameras[0]` exclusively.

Forty-nine WGSL shaders use `cameras[0]` to read camera data. The storage buffer is `array<Camera, 2>` everywhere, and only index 0 is consumed. The switch to `@builtin(view_index)` and `cameras[view_index]` would enable single-pass multiview: one draw call per mesh, vertex cost drops from 2x to 1x, and stereo depth rendering becomes correct. The infrastructure is ready and tested. The shader change is mechanical but touches every WGSL file.

The foliage pass notes: "cameras[0], not `@builtin(view_index)`: that builtin requires the MULTIVIEW feature... A future single-pass stereo path enables multiview and swaps these to `cameras[view_index]`." The foliage placement pass also notes "single-pass stereo cull can union cameras[0] and cameras[1]."

For now dual-pass works. The vertex cost at VR resolutions (~2K per eye) is within budget for the forward renderer on current hardware. Stereo depth rendering—where both eyes need the same depth-prepass results without double-processing—is the driver for completing the switch.

---

## What Lands and What Waits

| Component | Status |
|---|---|
| `helio-xr` crate: instance, session, swapchain, input, camera math | Complete |
| `Renderer::render_xr()` frame loop | Complete |
| Vulkan instance/device creation through OpenXR | Complete |
| PC mirror blit with lazy pipeline cache | Complete |
| Controller input across 4 profiles | Complete |
| `GraphTexturePool::set_xr_mode()` + `multiview_mask` injection | Complete |
| Dual-pass stereo rendering | Active |
| Single-pass multiview (Vulkan `VK_KHR_multiview`) | Infrastructure ready, shaders not updated |
| Forward rendering for VR | Active (recommended mode) |
| Hand tracking, passthrough, foveation, haptics | Schema only |

The asymmetry between the landed infrastructure and the pending shader update is deliberate. Dual-pass lets every existing shader, pass, and post-effect work unchanged. The renderer ships VR on dual-pass, measures frame time, and switches to multiview when vertex budget demands it. The infrastructure does not need to be re-debugged at that point.

The scene at `examples/vr/main.rs` renders through a headset at 90 Hz. The swapchain pool is pre-allocated. The mirror blit is lazily cached. The controller spaces are created once and reused. The session state machine pumps silently in the background. And the black wedges from the swapped matrix columns are gone—pinned by three tests in `camera.rs` that document every previous failure mode.

*Helio is open at [github.com/Far-Beyond-Pulsar/Helio](https://github.com/Far-Beyond-Pulsar/Helio). The XR code lives in `crates/helio-xr/` and the renderer integration in `crates/helio/src/renderer/render.rs`. The VR demo is at `crates/examples/vr/`.*
