---
title: "Quasar: A Lock-Free Spatial Audio Engine in Rust"
date: "2026-08-02"
author: ["tristanpoland"]
tags: ["rust", "quasar", "audio", "architecture", "pulsar"]
description: "A deep technical walkthrough of Quasar, the modular spatial audio engine we built in Rust for Pulsar. The hybrid baked-plus-real-time architecture, the lock-free triple buffer that lets the audio thread never block, the 16-line FDN reverb with a Householder feedback matrix, the GPU compute backend for ray tracing acoustic paths in WGSL, and what it takes to keep the audio thread at zero allocations."
thumbnail: /post_thumb/quasar.png
---

## Why Spatial Audio Needs a Different Architecture

Game audio has a threading problem. The audio callback runs at 48 kHz with a buffer of 256 samples. That gives you about 5.33 milliseconds to compute every sample before the buffer underruns and the user hears a pop. In that window you cannot allocate memory. You cannot take a mutex. You cannot write to a log file. And you certainly cannot trace a ray through a BVH to figure out how sound bounces off the cathedral walls.

The spatial computation takes orders of magnitude longer than the audio callback allows. Where is the sound source. What surfaces does the path cross. How much does the wall absorb. What's the reverb time of the room. A single ray intersection against a scene with 10,000 triangles costs maybe a microsecond on a good day. A full spatial query with direct path, early reflections, and reverb estimation can cost hundreds of microseconds or a few milliseconds. That work needs to happen on a separate thread at a lower rate. The results need to reach the audio thread without either thread ever waiting on the other.

This is the problem Quasar was built for. It is the spatial audio engine for Pulsar, written in Rust. The design centers on a lock-free parameter exchange between a compute thread running at 15-30 Hz and an audio thread running at 48 kHz. The two threads never synchronize. They never block. They communicate through a triple buffer with atomic index swaps.

Static scenes with baked acoustics run off a probe grid with trilinear interpolation. Dynamic scenes use a real-time backend that traces paths through a BVH on CPU or GPU. Or you blend both. Real-time ray tracing for direct path and early reflections. Baked data for the late reverb tail. The engine is modular, and you pick your tradeoffs.

This post covers how all of it works. The triple buffer. The probe grid. The material system. The DSP graph. The CPU and GPU backends. The FDN reverb with the Householder feedback matrix that took the longest to tune.

---

## The Threading Model and the Triple Buffer

Three threads touch Quasar's state. The game thread owns the scene and the listener position. The compute thread runs spatial queries. The audio thread processes samples. Only the first two share data freely. The game thread writes new positions, the compute thread reads them. The boundary between the compute thread and the audio thread is where the lock-free contract lives.

`ParameterTripleBuffer` in `quasar-core` is the mechanism. It holds three slots of `SpatialCoefficients` behind `UnsafeCell`, with three atomic index pointers and a monotonically increasing version counter:

```rust
pub struct ParameterTripleBuffer {
    buffers: [UnsafeCell<SpatialCoefficients>; 3],
    write_index: AtomicU32,
    read_index: AtomicU32,
    staging_index: AtomicU32,
    latest_version: AtomicU64,
}
```

The producer path is `begin_write()`, mutate, `end_write()`. `begin_write()` returns a `&mut SpatialCoefficients` pointing at whatever slot `write_index` currently owns. `end_write()` stamps the latest version into the slot and atomically swaps `write_index` with `staging_index`. After the swap, the slot the producer was just writing to becomes the staging slot. Available for the consumer to claim on its next `update()`.

The consumer path is `update()` then `read()`. `update()` atomically swaps `staging_index` with `read_index`, claiming whatever the producer has published since the last read. `read()` returns `&SpatialCoefficients` pointing at the now-stable read slot.

Three slots, three indices, always pointing to distinct buffers. The producer and consumer never touch the same slot at the same time. No mutexes. No atomics on the hot path except the two swaps.

`SpatialCoefficients` carries everything the audio thread needs to render spatial audio for a single source:

```rust
pub struct SpatialCoefficients {
    pub source_id: u32,
    pub direct_gain: Band8,
    pub direct_delay_samples: f32,
    pub early_reflections: Vec<EarlyReflectionCoeffs>,
    pub late_t60: Band8,
    pub late_gain_db: f32,
    pub version: u64,
}
```

`Band8` is the universal frequency representation. Eight floats covering the standard octave bands from 62.5 Hz to 8 kHz. Every spatial parameter in the engine is frequency-dependent. Direct attenuation. Reverb time. Material absorption. The audio thread receives these as pre-computed coefficients and applies them through biquad filters, fractional delays, and the FDN reverb. It never runs a ray intersection. It never evaluates a material formula. All of that happens on the compute thread.

---

## The Probe Grid: Baked Acoustics With Trilinear Interpolation

The offline path starts with Nebula, the companion baking tool. Nebula takes a static scene, places acoustic probes at regular intervals, and bakes impulse responses at each probe using path tracing. The output is a set of `AcousticProbe` points. Position. Per-band RT60. A time-series of 8-band energy samples.

Quasar consumes this data at runtime through `AcousticProbeGrid`. The grid is a 3D axis-aligned structure with `grid_origin`, `grid_spacing`, and `grid_dims`. Probes are stored in a flat `Vec<AcousticProbe>` in row-major order. X varies fastest, then y, then z:

```
index = z * grid_dims[1] * grid_dims[0] + y * grid_dims[0] + x
```

Given a listener position inside the grid, `cell_index()` computes the enclosing cell `[cx, cy, cz]` and returns the eight corner probe indices. `trilinear_interpolate()` computes fractional weights `wx, wy, wz` within the cell and blends the eight corner values:

```rust
fn trilinear_interpolate(&self, weights: [f32; 3], corners: [&AcousticProbe; 8]) -> AcousticProbeSample {
    let [wx, wy, wz] = weights;
    let c0 = corners[0].t60.lerp(&corners[1].t60, wx);
    let c1 = corners[2].t60.lerp(&corners[3].t60, wx);
    let c2 = corners[4].t60.lerp(&corners[5].t60, wx);
    let c3 = corners[6].t60.lerp(&corners[7].t60, wx);
    let c01 = c0.lerp(&c1, wy);
    let c23 = c2.lerp(&c3, wy);
    let t60 = c01.lerp(&c23, wz);
    let quality = (1.0 - (wx - 0.5).abs() * 2.0)
                * (1.0 - (wy - 0.5).abs() * 2.0)
                * (1.0 - (wz - 0.5).abs() * 2.0);
    // ...
}
```

The `interpolation_quality` field peaks at 1.0 at the center of a cell and falls to 0.0 at the edges. Good for blending decisions. If the listener is near a cell boundary, the interpolation is less reliable. The engine can boost the blend rate or fall back to a nearest-probe sample.

The nebula import bridge lives behind the `nebula-import` feature flag. It deserializes bincode-format bake files and transposes the 8-band impulse response data into `Vec<Band8>`. For irregularly-spaced probe sets, the grid dimensions are set to `[n, 1, 1]` and the sampler falls back to nearest-probe lookup.

---

## The Hybrid Sampler: Choosing Your Tradeoff

`HybridProbeSampler` sits between the compute backend and the audio engine. It dispatches each spatial query according to the active `HybridSamplingStrategy`:

```rust
pub enum HybridSamplingStrategy {
    BakedOnly,      // probe grid only
    RealTimeOnly,   // ray tracing only (CPU or GPU)
    HybridBlend,    // ray tracing for direct + early, grid for late reverb
}
```

`BakedOnly` samples the probe grid at the listener position. It computes inverse-distance attenuation from the source and returns a `SpatialQueryResult` with no early reflections. This is the cheapest path. Zero ray intersections. Zero material evaluations. Good for static environments where the acoustics are pre-baked and nothing moves.

`RealTimeOnly` delegates entirely to the `IAcousticComputeBackend` trait. The backend traces rays through the scene. It evaluates material absorption at each hit. It computes specular reflections. It estimates statistical reverb from the room geometry. This path supports dynamic geometry. Moving walls, collapsing structures, anything that changes the acoustic environment frame to frame.

`HybridBlend` calls the real-time backend for direct path and early reflections. Then it overlays the late reverb T60 from the probe grid. This is the interesting middle ground. The direct path and early reflections are the parts of spatial audio where dynamic behavior matters most. A door opening changes the direct path instantly, and the listener hears the difference. The late reverb tail is less position-sensitive within a room. A baked T60 from a probe grid is nearly indistinguishable from a real-time estimate, and it costs nothing to sample.

The `resolve()` method on `HybridProbeSampler` dispatches by strategy:

```rust
pub fn resolve(&self, query: &SpatialQuery, materials: &dyn MaterialProvider)
    -> Result<SpatialQueryResult, SpatialAudioError>
{
    match self.strategy {
        HybridSamplingStrategy::BakedOnly => {
            let probe = self.probe_grid.as_ref().ok_or(...)?;
            let sample = probe.sample(&listener_pos)?;
            let dist = distance(source_pos, listener_pos);
            let atten = Band8::splat(1.0 / (1.0 + dist));
            Ok(SpatialQueryResult {
                direct_path: DirectPathResult {
                    attenuation: atten,
                    delay_samples: dist / 343.0 * 48000.0,
                    distance: dist,
                    occluded: false,
                    occlusion_factor: 1.0,
                },
                early_reflections: vec![],
                late_reverb: LateReverbEstimate {
                    t60: sample.t60,
                    early_late_split_secs: sample.early_late_split_secs(),
                    late_loudness_db: -10.0,
                },
            })
        }
        HybridSamplingStrategy::RealTimeOnly => {
            let backend = self.realtime_backend.as_ref().ok_or(...)?;
            let results = backend.query_spatial(&[query.clone()], materials);
            results.into_iter().next().ok_or(...)
        }
        HybridSamplingStrategy::HybridBlend => {
            let mut result = self.realtime_backend(...)?;
            if let Some(ref grid) = self.probe_grid {
                if let Ok(sample) = grid.sample(&listener_pos) {
                    result.late_reverb.t60 = sample.t60;
                }
            }
            Ok(result)
        }
    }
}
```

The compute thread calls `resolve()` for each active source at 15-30 Hz and publishes the result through the triple buffer. The audio thread reads the latest coefficients and renders the next block of audio.

---

## The Compute Backends: CPU BVH, WGPU, and a Stub

`IAcousticComputeBackend` defines the interface any real-time backend must implement:

```rust
pub trait IAcousticComputeBackend: Send + Sync {
    fn query_spatial(&self, queries: &[SpatialQuery],
                     materials: &dyn MaterialProvider) -> Vec<SpatialQueryResult>;
    fn supports_dynamic_geometry(&self) -> bool { false }
    fn update_scene(&mut self, scene: &AcousticScene) -> Result<(), SpatialAudioError>;
    fn trace_ray(&self, ray: &Ray) -> Vec<RayHit>;
}
```

Three implementations exist. `HardwareAcceleratorStub` is a no-op placeholder. It returns dummy results. Inverse-distance attenuation, no early reflections, a fixed 0.5-second RT60. It exists so the engine compiles and runs without any real backend selected.

`CpuSimdComputeBackend` is the production CPU path. At construction it builds a BVH from the scene's triangle mesh using the surface area heuristic:

```
For each axis (X, Y, Z):
  Sort triangles by centroid along that axis.
  Build prefix and suffix AABB arrays.
  For each split position, compute SAH cost:
    cost = 1.0 + (left_area * i + right_area * (n - i)) / n
  Pick the axis and split with the lowest cost.
```

Leaf nodes hold up to 4 triangles. Internal nodes store an AABB, child pointers, and the split axis. The BVH traversal is standard. Test the AABB, recurse into children if hit, return the closest intersection.

Ray-triangle intersection uses Moller-Trumbore. The `query_spatial` implementation processes sources in parallel with `rayon::par_iter()`. For each source it casts a shadow ray from the listener to the source for occlusion testing. Then it traces recursive specular reflections up to order 3 for early reflections. The late reverb estimate uses Sabine and Eyring statistical formulas computed from the scene's total surface area and per-band absorption:

```
avg_absorption[b] = sum(absorption[b] * triangle_area) / total_surface_area
Sabine_RT60[b] = 0.161 * V / (S * avg_absorption[b])
Eyring_RT60[b] = 0.161 * V / (-S * ln(1 - avg_absorption[b]))
final_RT60[b]  = min(Sabine, Eyring), clamped to [0.1, 10.0]
```

Air absorption follows ISO 9613-1, with oxygen and nitrogen relaxation frequencies computed from temperature and humidity. The per-band attenuation is `exp(-alpha[b] * distance)`.

`WgpuComputeBackend` dispatches the same ray tracing work to the GPU through WGSL compute shaders. The dispatch layout is one workgroup per source-listener pair, with 64 threads per workgroup. Each thread traces one stochastic ray per iteration, accumulating reflection energy and per-band absorption into a shared output buffer.

The WGSL shader contains a full Moller-Trumbore implementation and a PCG random number generator for ray direction sampling:

```wgsl
fn pcg() -> u32 {
    rng_state = rng_state * 747796405u + 2891336453u;
    let word = ((rng_state >> ((rng_state >> 28u) + 4u)) ^ rng_state) * 277803737u;
    return (word >> 22u) ^ word;
}
```

The output uses double-buffered staging. Two output buffers and two staging buffers, toggled atomically. The CPU reads the previous frame's results while the GPU processes the current frame. The material evaluation runs on the GPU side through a switch on `model_id`, with identical formulas to the CPU evaluators.

---

## The Material System: Dynamic Physical Acoustics

Materials in Quasar are not hardcoded structs. They are dynamic physical transfer functions composed from a `MaterialModelId` and a raw byte-aligned `MaterialParameterBuffer`. The same byte buffer can be cast to a typed struct on the CPU via `bytemuck` or blitted directly to a GPU storage buffer.

Three material models are built in.

**Tabular (model ID 1)** is the simplest. A straightforward lookup table with 24 f32 values. Absorption, scattering, and transmission for each of the 8 octave bands. 96 bytes total. No computation, just a direct read. Good for artist-authored materials where the acoustic properties are measured or tuned by hand.

**Delany-Bazley (model ID 2)** implements the empirical porous absorber model. Parameters are flow resistivity in Rayls/m and thickness in meters. Flow resistivity typically ranges from 1,000 to 100,000. Thickness ranges from centimeters to tens of centimeters. For each octave band frequency, the model computes complex characteristic impedance and propagation constant. It then derives surface impedance and finally absorption from the reflection coefficient:

```
E = rho_0 * f / R_s
Zc = Z_0 * (1.0 + 0.0571 * E^-0.754) - j * Z_0 * 0.087 * E^-0.732
k  = (omega / c_0) * (1.0 + 0.0978 * E^-0.700) - j * (omega / c_0) * 0.189 * E^-0.595
Zs = -j * Zc * cot(k * thickness)
R  = (Zs - Z_0) / (Zs + Z_0)
alpha = 1.0 - |R|^2
```

The complex cotangent is computed manually. The WGSL shader has the same arithmetic. This model is accurate for fibrous absorbers like rockwool, fiberglass, and acoustic foam. A 5cm panel with 20,000 Rayls/m flow resistivity absorbs mostly high frequencies. A 10cm panel with 10,000 Rayls/m absorbs across the full spectrum.

**Resonant Panel (model ID 3)** models membrane absorbers as mass-spring systems. Parameters are panel mass in kg/m² and cavity depth in meters. Panel mass is typically 1-20 kg/m². Cavity depth is typically 0.02-0.5 meters. The resonant frequency is:

```
f0 = (c_0 / (2 * pi)) * sqrt(rho_0 / (m * d))
```

With the Q-factor computed empirically from mass and depth, the absorption profile is a Lorentzian peak:

```
alpha(f) = 0.95 / (1.0 + Q^2 * (f/f0 - f0/f)^2)
```

This produces narrow-band absorption centered at the resonant frequency. The kind of behavior you get from a thin plywood panel with an air gap behind it.

`AcousticMaterialRegistry` manages instances at runtime. Each instance is a `(model_id, parameter_buffer)` pair stored in a `Vec` behind an `RwLock`. Instances are referenced by a `u32` handle, the index into the vector. The registry supports hot-swapping. Updating an instance's parameter buffer takes effect immediately without rebuilding any acceleration structure:

```rust
reg.update_instance(handle, new_params);
// Next query_spatial() call uses the new parameter values.
// The BVH does not need to be rebuilt.
```

On the GPU side, `GpuMaterialLayout::build()` concatenates all parameter buffers into a single byte array with 16-byte alignment per entry. It produces a descriptor array the WGSL shader uses for dispatch.

---

## The DSP Graph: Zero Allocation at 48 kHz

The audio thread runs `AudioNodeGraph`. Every node in the graph pre-allocates its state at construction time. The hot path, the `process()` method called for every 256-sample block, never calls `alloc`. It never takes a lock. It never touches the heap.

`AudioBuffer` is a fixed-size inline array:

```rust
pub struct AudioBuffer {
    data: [[f32; DEFAULT_BLOCK_SIZE]; MAX_AUDIO_CHANNELS],  // 32 x 256
    num_channels: u16,
    num_samples: u16,
}
```

32 channels at 256 samples each. 32 KiB total, on the stack. No allocation at construction. No allocation at copy. No allocation at clear. The graph owns a `Vec<AudioBuffer>` of scratch buffers sized to the maximum number of concurrently active sources, allocated once at graph construction.

The processing chain for each source flows through five nodes.

**DirectivityNode** applies a source radiation pattern. Four patterns are supported: omnidirectional (gain = 1.0 everywhere), cardioid (gain = 0.5 * (1 + cos(theta)), null at 180 degrees), figure-8 (gain = |cos(theta)|), and spherical harmonics up to order 1.

**AirAbsorptionOcclusionNode** applies per-band attenuation and fractional delay. Internally it maintains 8 biquad filters per channel, one per octave band, plus a Hermite-interpolating delay line. The per-band attenuation from the spatial query is converted to lowpass cutoff frequencies:

```
cutoff[b] = centre_freq[b] * sqrt(attenuation[b]) + 20 Hz
```

Lower attenuation means more occlusion. The cutoff shifts lower and rolls off the high frequencies.

**EarlyReflectionDelayNode** implements a multi-tap delay. Input audio is downmixed to mono and pushed through a shared delay line. Each early reflection from the spatial query becomes a tap with a fractional delay and a stereo pan:

```
pan = azimuth / pi                 // [-1, 1]
angle = pi/2 * (pan + 1) * 0.5     // [0, pi/2]
gain_left = cos(angle)
gain_right = sin(angle)
```

**LateReverbNode** is the FDN. The most algorithmically dense node. 16 delay lines with pairwise coprime lengths spanning from 2 ms to 73 ms at 48 kHz:

```rust
const FDN_DELAY_LENGTHS: [usize; 16] = [
    719, 857, 1103, 1321, 1613, 1871, 2213, 2657,
    3079, 3491, 109, 151, 197, 251, 313, 401,
];
```

Each delay line has a 0.5 Hz sinusoidal LFO adding +/- 2 samples of delay modulation. This smooths out metallic resonances. Each line also has a one-pole lowpass damping filter. The coefficient is derived from the T60: `damping = exp(-3.0 / (avg_t60 * sample_rate))`.

The feedback matrix is a Householder reflection:

```rust
pub fn feedback_matrix(input: &[f32; 16]) -> [f32; 16] {
    let sum: f32 = input.iter().sum();
    let scale = 2.0 / 16.0;
    let mut out = [0.0_f32; 16];
    for i in 0..16 {
        out[i] = -input[i] + scale * sum;
    }
    out
}
```

This matrix is orthogonal. `H * H^T = I`. It guarantees energy preservation in the feedback loop. Combined with a loop gain of 0.85, below unity for stability, the FDN produces a dense, natural-sounding reverb tail.

Per-sample processing within the FDN:

```rust
fn process_fdn_channel(&mut self, input_sample: f32) -> f32 {
    let signal = self.pre_delay.tap(self.pre_delay_samples);
    self.pre_delay.push(input_sample);

    let mut vec_in = [0.0_f32; 16];
    for i in 0..16 {
        let mod_offset = (self.modulation_phase[i] * std::f32::consts::TAU).sin() * 2.0;
        self.modulation_phase[i] += 0.5 / self.sample_rate;
        let tap_pos = (FDN_DELAY_LENGTHS[i] as f32 + mod_offset)
            .clamp(0.0, self.max_samples as f32 - 3.0);
        let delayed = self.delay_lines[i].tap(tap_pos as f32);
        vec_in[i] = self.damping_filters[i].process(delayed);
    }

    let vec_out = Self::feedback_matrix(&vec_in);
    for i in 0..16 {
        let feedback = vec_out[i] * 0.85;
        self.delay_lines[i].push(signal / 16.0 + feedback);
    }

    vec_out.iter().sum::<f32>() * (1.0 / 16.0_f32.sqrt())
}
```

**MasterDecoderNode** handles output format conversion. Three modes. Binaural with 2 channels and stereo panning from azimuth. VBAP with configurable speaker layouts for stereo, 5.1, 7.1.4, or quad. Ambisonic decoding up to configurable order.

`EqualPowerCrossfader` sits between the triple buffer read and the DSP graph. When the compute thread publishes new `SpatialCoefficients`, the crossfader blends from the previous values to the new values over a configurable fade window:

```
g_cur = cos(pi * t / 2)
g_tgt = sin(pi * t / 2)
```

The constant-power property, `cos^2 + sin^2 = 1`, ensures no volume dip or spike during the transition. All parameters are crossfaded in lockstep. Direct gain, delay, early reflection taps, and late reverb parameters.

---

## What It Costs

The CPU SIMD backend on a Ryzen 9 7950X processes a spatial query for one source against a scene of 10,000 triangles in about 0.2 ms. With 3 bounces of specular reflections. Scaling to 64 sources at 30 Hz gives a compute budget of roughly 12.8 ms per frame. Headroom remains for BVH updates when geometry changes.

The GPU backend dispatches 256 rays per source-listener pair in a single workgroup. At 64 threads per workgroup, each thread traces 4 rays. The dispatch for 32 sources produces 32 workgroups. Negligible utilization on any modern GPU. Scaling to 256 sources at 16 rays each fits in a single dispatch of 64 workgroups. Completes in roughly 0.1-0.3 ms on an RTX 4090 depending on BVH complexity.

The audio thread processes a full DSP chain for a single source in approximately 0.015 ms per 256-sample block on the same CPU. Directivity, occlusion, early reflections, FDN reverb, stereo decode. For 64 simultaneous sources, the total DSP cost per block is about 1 ms. That leaves over 4 ms of headroom in the 5.33 ms budget.

The FDN reverb uses 16 delay lines of up to 3491 samples each. About 218 KB of state per channel. With pre-delay and the Hermite-interpolating delay lines for early reflections, the total DSP memory per source is roughly 256 KB. All pre-allocated.

---

## What It Doesn't Do

Quasar does not handle audio file decoding, streaming, or mixing. Those responsibilities belong to the host engine's audio system. Quasar takes a mono or stereo input buffer and applies spatial transforms. It is a spatial audio renderer.

The early reflection model is specular only. Diffuse reflections, the kind that produce the smooth build-up of energy before the reverb tail, are handled implicitly by the FDN reverb rather than explicitly modeled as discrete paths. A full diffuse path tracing backend could improve accuracy for highly scattering environments. The current approach keeps the compute cost bounded.

The GPU backend's staging readback is not fully wired in the current build. The WGSL shader compiles and the bind groups are set up. The results fall back to CPU-computed values while the asynchronous readback pipeline is being finalized.

The probe grid currently requires a regular axis-aligned layout. Irregular probe placements from Nebula bakes are supported but fall back to nearest-probe lookup rather than full trilinear interpolation.

---

## Where It Goes Next

The immediate work is finishing the GPU backend's staging readback. Adding support for multiple simultaneous probe grids with spatial blending. Transitioning from one baked acoustic zone to another as the listener moves through connected rooms.

The FDN reverb is parametric but not adaptive. T60, pre-delay, and late gain are set per-source from the spatial query results. The delay line lengths and feedback matrix are fixed. A variable-length FDN that adjusts its density based on the estimated room volume would improve the sense of spatial presence in small versus large spaces.

On the material side, we want to add frequency-dependent scattering for the CPU backend. A fourth material model for structured surfaces. Periodic diffusers, slatted walls, and other geometry whose acoustic behavior depends on the angle of incidence.

The Nebula integration is functional but the format is still in flux. As the baking tool matures, the import bridge will need to handle higher-order ambisonic impulse responses and time-varying reverb parameters for scenes with moving geometry.

Everything is at github.com/Far-Beyond-Pulsar/Quasar.
