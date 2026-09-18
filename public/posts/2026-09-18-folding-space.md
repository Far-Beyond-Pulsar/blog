---
title: "Portals Aren’t Cameras: How Helio Folds Space in WGSL"
date: "2026-09-18"
author: ["tristanpoland"]
tags: ["rust", "helio", "graphics", "wgsl", "portals", "non-euclidean", "architecture", "pulsar"]
description: "How Helio renders portals as transition maps across a discrete fourth spatial axis, transforming geometry directly into the shared G-buffer through GPU-driven culling, nested spatial clipping, indirect draws, and temporally stable motion vectors."
thumbnail: /post_thumb/wormhole.jpg
---

# Portals Aren’t Cameras: How Helio Folds Space in WGSL

*Cover art by erikshoemaker on DeviantArt*

Most real-time portal implementations begin with a camera.

Place a second camera at the destination, transform its pose through the portal pair, render what it sees into a texture, then display that texture on the portal surface. The method is understandable, flexible, and often the right engineering choice. It also carries an awkward implication: a portal is treated as a screen showing another render rather than an opening through which the same scene continues.

That distinction sounds philosophical until portals start nesting.

One portal view means another view of some part of the scene. A portal visible through that portal means another level of work. Add moving coordinate spaces, temporal anti-aliasing, deferred materials, occlusion, and several portals visible in the same frame, and the camera abstraction starts leaking into the rest of the renderer. Each view needs visibility decisions, target management, depth handling, and temporal history. Recursion multiplies those obligations.

Helio, the renderer behind Pulsar, takes a different route. A portal is a mapping between coordinate spaces. Geometry selected as visible through the opening is transformed through that mapping and written into the same G-buffer and depth buffer as the ordinary scene. There is no portal color texture and no compositing pass pretending a flat surface is a hole.

The result still requires additional geometry work. Visible triangles remain visible triangles. The architectural difference is larger than moving the same cost somewhere else, though. Portal rendering stays inside our GPU-driven scene pipeline, uses the same material data, writes spatial information rather than a precomposed picture, and participates in the same depth-tested deferred frame. The engine is rendering one connected spatial system assembled from several coordinate spaces.

## Why the Camera Method Becomes Its Own Renderer

The familiar render-to-texture method starts innocently. Create a texture matching some chosen portal resolution. Transform a camera through the source and destination portals. Render the destination scene. Bind that result as the portal surface’s color texture.

Already, several questions appear. How large should the texture be? A fixed resolution wastes work when the portal is small and looks soft when it fills the screen. A dynamically sized target reacts better, but now the engine needs allocation buckets, reuse rules, and hysteresis so a portal hovering near a size boundary does not constantly resize its resources. Several portals require several views, or a scheduling scheme clever enough to reuse targets without destroying data still needed later in the frame.

The virtual camera also needs a near plane aligned with the destination opening. A normal camera frustum may include geometry between the virtual camera and portal plane, allowing objects from the wrong side of the destination wall to leak into the image. Oblique near-plane projection is a standard answer. Eric Lengyel’s treatment replaces a conventional frustum plane with an arbitrary clipping plane ([*Oblique View Frustum Depth Projection and Clipping*](https://terathon.com/lengyel/Lengyel-Oblique.pdf)). It works, but it means the portal view owns a modified projection matrix and all the numerical edge cases around it.

Recursion turns the view into a tree. At depth one, the main camera sees portal A. Its virtual camera sees portal B. Rendering B requires another transformed camera, another visibility problem, and either another texture or careful rendering back into an earlier target. Depth three repeats the process. Practical systems cap recursion, reduce resolution with depth, use stencil regions, reuse prior frames, or stop rendering portals once their projected area becomes small. These are sensible solutions. They are also evidence that the portal has grown into a secondary view-management system.

The flat image creates integration work after rendering too. Deferred lighting normally expects per-pixel depth, normals, roughness, metallic response, and whatever other surface properties the engine stores. A portal color texture has already collapsed those properties into radiance. Screen-space effects see the portal polygon’s depth unless the system separately transports and reconstructs destination depth. TAA sees motion on the portal surface unless another velocity field comes with the color. Fog, decals, SSAO, depth of field, motion blur, picking, and editor selection each need an answer for whether the portal is a surface or a window.

None of this makes camera portals primitive. A mature camera-based implementation can transport depth, velocity, and other buffers, and stencil recursion can preserve convincing spatial boundaries. The point is architectural. Once enough spatial data crosses the portal, the implementation is already trying to undo the flattening introduced by rendering the destination as an image.

Helio begins on the other side of that decision. It transports the geometry’s spatial state through a coordinate mapping before rasterization. The rasterizer then produces the G-buffer values at their final screen locations.

## The Useful Part of the Wormhole Analogy

The mathematical intuition came before the implementation.

A wormhole is usually described as a connection between regions of spacetime. In the classic Ellis geometry, two asymptotically flat regions meet at a throat. Ellis’s original 1973 paper calls the construction a “drainhole,” and later literature commonly groups the Ellis and Bronnikov solutions together as the Ellis-Bronnikov wormhole ([Ellis, *Ether flow through a drainhole*](https://doi.org/10.1063/1.1666161)).

For a game renderer, we can leave the field equations behind and retain the underlying spatial construction: points and directions crossing an opening are re-expressed in another coordinate chart.

Suppose the source and destination openings have rigid transforms $P_s$ and $P_d$. A point in source-world coordinates can be taken into the source portal’s local frame and then brought out through the destination frame:

$$
\mathbf{p}' = P_d F P_s^{-1}\mathbf{p}
$$

$F$ is the convention change between the two portal faces. Depending on how their local axes are defined, it may contain a half-turn or a reflection-like reorientation. Directions use the rotational part of the mapping. Positions use rotation and translation.

Helio turns that construction into the spatial model used by the renderer. It does not numerically solve Einstein’s field equations or simulate the curved metric of a physical Ellis-Bronnikov throat. It does implement the part relevant to a portal: disjoint spatial regions, explicit transition maps, and the continuous transport of positions and tangent frames across their identified boundaries. “Folded space” is not decorative language here. It describes the topology presented by the engine.

The fourth component in `vec4<f32>(position, 1.0)` is still worth distinguishing from the fourth spatial coordinate. That component is the homogeneous value used by standard 4×4 affine transforms. WGSL defines vectors and matrices directly, including matrix-vector multiplication, in the language specification ([W3C WGSL specification](https://www.w3.org/TR/WGSL/#arithmetic-expr)). Setting it to one lets a matrix apply translation as well as rotation. Helio’s additional spatial coordinate is stored separately as the coordinate-space index.

## A Discrete Fourth Spatial Axis

Picture a stack of transparent maps. Every map has its own complete 3D coordinate system. Two objects may both claim to be at $(10, 5, 2)$, yet belong to different maps and never meet. Their full locations differ along another coordinate.

We can write the engine’s spatial domain as:

$$
\mathcal{W} = \mathbb{R}^3 \times S
$$

$S$ is the discrete set of coordinate spaces. A complete engine-space location is therefore $(x,y,z,s)$. Two objects with identical $(x,y,z)$ values remain spatially disjoint when their values of $s$ differ. In that concrete sense, the sublevel index is a fourth spatial axis. It participates in the identity of a location and determines which objects can coexist, collide, and become visible to one another.

Its discreteness does not make it a fake dimension. It means the axis is not modeled as another copy of $\mathbb{R}$. There is no meaningful sublevel $1.4$, and an object cannot freely rotate through the $x$–$s$ plane. Travel along $S$ happens through defined mappings between its 3D leaves. Portals are those mappings.

This resembles an atlas of charts more than a single global Euclidean room. Each value of $s$ selects a full 3D leaf with its own local coordinates. A portal identifies a bounded region in one leaf with a bounded region in another. Within either leaf, normal Euclidean relationships apply. At the opening, the transition function tells the engine how the coordinates on one side continue on the other.

That model explains something a render-only description tends to hide. A portal does not merely answer “what color belongs here?” It answers “where is here?” An object at $(4,2,9,s_3)$ can be visible from $s_0$ through a chain of transitions even though there is no direct global 3D placement shared by both spaces. The renderer constructs the placement relevant to the current observation by composing the chain.

The discrete axis can also carry topology impossible to embed cleanly into one ordinary 3D coordinate system. Two rooms can each be larger inside than the structure containing their entrances. Several doors can lead into separate leaves occupying the same apparent exterior volume. A corridor can return to itself with a rotated frame. A moving carrier can hold a stable interior whose local geometry never inherits large world coordinates. The contradiction exists only if every location is forced into one $(x,y,z)$ chart. Add $s$, and the addresses are distinct.

Distance along this world is path-dependent. Within a leaf, ordinary metric distance works. Between leaves, a route includes one or more transition edges. For gameplay, navigation can treat coordinate spaces as nodes in a graph and portals as directed or bidirectional edges. A path cost can combine continuous travel inside each leaf with the cost of crossing its transitions. The renderer solves a related problem in reverse: start from a visible portal chain and map candidate surfaces toward the camera.

Helio calls those maps coordinate spaces.

Slot zero is the ordinary world and always contains the identity matrix. Other slots can represent a sublevel, the interior carried by a moving sky whale, a ship, or any rigid chunk of geometry whose internal coordinates should remain stable while the whole space moves. An instance stores an eight-bit `space_id` inside its flags. The shader uses it to fetch a matrix from `coordinate_spaces`:

```wgsl
let space_id   = (inst.flags >> 8u) & 0xFFu;
let space      = coordinate_spaces[space_id];
let space_prev = coordinate_spaces_prev[space_id];

let world_pos = space * (inst.transform * vec4<f32>(v.position, 1.0));
```

This gives sublevels and portals a shared spatial foundation. Moving a sublevel means updating one coordinate-space matrix. Instances inside it retain their local transforms. An ordinary object still reads slot zero and receives the identity transform.

It is easy to oversell that as “free.” No shader operation is free, and the cost depends on hardware, compiler decisions, cache behavior, occupancy, and the surrounding shader. What we can say is narrower: the operation is a normal matrix-vector transform, a workload GPUs and shading languages are designed to express efficiently. The design avoids rewriting every instance transform on the CPU when a whole rigid space moves.

The same coordinate belongs in physics and gameplay. Collision broad phases can partition by $s$ before considering $(x,y,z)$. Queries acquire a coordinate-space context. Entity ownership and traversal preserve it. A portal changes the spatial address of an object by applying the transition into another leaf. The renderer’s matrix table is one realization of a wider model rather than a visual trick isolated from the rest of the engine.

## A Portal View Is a Transform, Not a Camera

Each visible portal relationship is represented on the GPU as a `GpuPortalView`:

```wgsl
struct GpuPortalView {
    transform:         mat4x4<f32>,
    inverse_transform: mat4x4<f32>,
    half_extent:       vec2<f32>,
    coordinate_space:  u32,
    _pad:              u32,
}
```

The transform places destination geometry into the coordinate frame visible through an entry portal. Its inverse gives the fragment shader a cheap way to ask where a transformed point lies relative to the portal plane and rectangular aperture. `half_extent` describes that local opening. `coordinate_space` points at the matrix used for the mapping.

One portal is simple. Nested portals turn the mapping into a chain.

For spaces $s_a$ and $s_b$, a portal defines a transition over the region covered by its aperture:

$$
T_{a \rightarrow b}: U_a \subset \mathbb{R}^3 \rightarrow U_b \subset \mathbb{R}^3
$$

This transition changes both parts of the spatial address. It moves the point from one value of the discrete coordinate $s$ to another, then maps its continuous $(x,y,z)$ coordinates into the receiving chart. Nested portals compose those transitions.

$$
M_{chain} = M_0 M_1 \cdots M_{n-1} M_{object}
$$

Matrix order is doing real work here. A point begins in the object’s own local frame, enters its containing coordinate space, passes through the deepest visible portal, then works outward until it reaches the entry visible to the camera. The code applies those transforms deepest first because matrix multiplication reads in the opposite direction from the route a point travels.

Our current GPU chain representation has a maximum depth of three:

```wgsl
const MAX_CHAIN_DEPTH: u32 = 3u;

struct GpuPortalChain {
    portals: array<u32, 3>,
    depth:   u32,
}
```

That limit is policy, not a mathematical boundary. Unbounded recursion is a bad fit for predictable frame time, and a fixed upper bound keeps storage layouts, culling, shader control flow, and intermediate clipping data straightforward. Three layers are enough to demonstrate actual nested geometry without allowing one unfortunate hall of mirrors to consume the frame.

The chain is best understood as a path through $S$. A depth-one chain crosses one edge. A depth-three chain crosses three, and the same portal may occur more than once if the topology loops back through it. The array stores the path, while the coordinate-space table supplies the rigid mapping attached to every step.

There is no need to bake every possible composition ahead of time. A moving sublevel can update its matrix, and every chain using it observes the new relation during the same frame. That is one of the quiet strengths of retaining the factorization. The engine stores the graph’s edges and composes the requested path on the GPU instead of materializing a second transformed copy of the scene for every possible route.

## The GPU Decides What Gets Duplicated

Transforming the entire destination world for every portal would merely relocate the brute force. Visibility still comes first.

Before the portal G-buffer write, Helio’s portal culling pass produces compacted instance lists for the surviving `(instance, chain)` pairs. Two parallel storage buffers reach the vertex shader:

```wgsl
@group(0) @binding(5)
var<storage, read> portal_compacted_indices: array<u32>;

@group(0) @binding(8)
var<storage, read> portal_compacted_chains: array<u32>;
```

The first identifies the original instance. The second says which portal chain made that duplicate visible. This pairing is important. The same mesh instance can appear through two different openings, or at two recursion depths, and each appearance needs a different composed transform.

Draw counts live in an indirect buffer. The renderer issues `multi_draw_indexed_indirect`, so the CPU does not loop over every surviving portal copy and submit it individually. In wgpu, multi-draw indirect consumes multiple indexed draw argument structures from a buffer, with support exposed through the relevant device feature ([wgpu `RenderPass::multi_draw_indexed_indirect`](https://docs.rs/wgpu/latest/wgpu/struct.RenderPass.html#method.multi_draw_indexed_indirect)).

One nuance is worth spelling out. “A single indirect draw call” does not mean every portal triangle appears without additional drawing, and it does not mean one hardware draw internally. The API call contains multiple indirect draws, organized by mesh and material draw group. The win is reduced CPU submission and a GPU-produced visibility stream, not the abolition of draw work.

The grouping matters because a renderer rarely draws “the scene” as one undifferentiated bag of triangles. Mesh and material combinations define pipeline-compatible work. Each indirect command covers a draw group, and `first_instance` plus `instance_count` select the compacted region belonging to it. `@builtin(instance_index)` therefore arrives already pointed at the correct section of `portal_compacted_indices`.

That removes another tempting CPU loop. The shader does not receive one uniform saying “we are drawing portal chain 7 now,” followed by a separate submission for chain 8. `portal_compacted_chains` runs parallel to the instance list. Every surviving instance carries its chain identity through the same indirect stream:

```wgsl
let slot_idx  = portal_compacted_indices[instance_index];
let chain_idx = portal_compacted_chains[instance_index];

let inst  = instance_data[slot_idx];
let chain = portal_chains[chain_idx];
```

The mapping belongs to the instance occurrence, not the draw call. Two copies of the same original instance can sit next to each other in the compacted output and follow different chains. The geometry and material stay shared. Only the route through space changes.

## Following One Vertex Through a Three-Portal Chain

Take a vertex with local position $\mathbf{v}$. Its instance belongs to coordinate space $s_3$. The camera lives in $s_0$. Between them is a chain crossing $s_3 \rightarrow s_2 \rightarrow s_1 \rightarrow s_0$.

The first transform is the model matrix $M_{object}$. It places the vertex relative to its containing sublevel. Then $C_3$ places that complete sublevel in the frame used as input to the deepest portal transition:

$$
\mathbf{p}_3 = C_3 M_{object}\mathbf{v}
$$

The deepest transition maps it into the next visible leaf:

$$
\mathbf{p}_2 = C_2\mathbf{p}_3
$$

The middle transition produces:

$$
\mathbf{p}_1 = C_1\mathbf{p}_2
$$

The outer transition finally produces the position expressed in the world frame observed by the camera:

$$
\mathbf{p}_0 = C_0\mathbf{p}_1
$$

Projection happens once, at the end:

$$
\mathbf{p}_{clip} = VP_0\mathbf{p}_0
$$

That last line is the key departure from virtual-camera rendering. Helio does not project an intermediate view at each portal and resample the resulting image at the next one. It preserves the vertex as geometry through the whole chain, then projects the final mapped point with the real camera.

The shader evaluates the sequence from deepest to outermost:

```wgsl
var pos = own_space * (inst.transform * vec4<f32>(v.position, 1.0));

if chain.depth >= 3u {
    let p2 = portal_views[chain.portals[2]];
    pos = coordinate_spaces[p2.coordinate_space] * pos;
    stage_pos_2 = pos.xyz;
}

if chain.depth >= 2u {
    let p1 = portal_views[chain.portals[1]];
    pos = coordinate_spaces[p1.coordinate_space] * pos;
    stage_pos_1 = pos.xyz;
}

let p0 = portal_views[chain.portals[0]];
pos = coordinate_spaces[p0.coordinate_space] * pos;
```

`stage_pos_2` and `stage_pos_1` are not debugging leftovers. They preserve the vertex at two different moments in the composition. Later, the fragment shader needs to test the resulting surface against the aperture belonging to each chart. Once every matrix has been multiplied into a single final position, those intermediate relationships are gone. Saving them allows every portal to judge the fragment in the coordinate frame where that portal actually exists.

This is also why simply multiplying the whole chain into one matrix on the CPU would not eliminate all per-stage data. A precomposed matrix can produce $\mathbf{p}_0$ efficiently, but nested clipping still needs enough information to reconstruct or retain $\mathbf{p}_1$ and $\mathbf{p}_2$. The chain is both a transform and a record of the boundaries crossed.

## Chaining the Spaces in the Vertex Shader

The portal vertex shader starts in the instance’s own coordinate space. Then it walks the fixed-size chain from the deepest stage toward the outermost one:

```wgsl
let slot_idx  = portal_compacted_indices[instance_index];
let chain_idx = portal_compacted_chains[instance_index];
let inst      = instance_data[slot_idx];
let chain     = portal_chains[chain_idx];

let own_space_id = (inst.flags >> 8u) & 0xFFu;
let own_space     = coordinate_spaces[own_space_id];

var pos = own_space * (inst.transform * vec4<f32>(v.position, 1.0));

if chain.depth >= 3u {
    let p2 = portal_views[chain.portals[2]];
    pos = coordinate_spaces[p2.coordinate_space] * pos;
}

if chain.depth >= 2u {
    let p1 = portal_views[chain.portals[1]];
    pos = coordinate_spaces[p1.coordinate_space] * pos;
}

let p0 = portal_views[chain.portals[0]];
pos = coordinate_spaces[p0.coordinate_space] * pos;
```

Positions alone are not enough. Normals and tangents have to follow the geometry or normal mapping breaks the moment a portal rotates its destination.

The instance’s normal matrix already contains the inverse transpose needed for its model transform. Portal coordinate spaces are constrained to rigid transforms, so their upper 3×3 rotation blocks can be composed directly. That restriction is intentional. Arbitrary non-uniform scale would require different treatment for normals and could turn a clean portal mapping into a pile of edge cases.

Tangents take the regular upper 3×3 model transform, then the same portal rotations. The fragment shader reconstructs the bitangent from the transformed normal, tangent, and stored handedness sign. The whole tangent frame arrives in the same folded space as the vertex.

Lighting can now treat the visible duplicate like geometry placed in the main world. Material textures are sampled normally. The portal path writes albedo, normal, occlusion/roughness/metallic, emissive, auxiliary data, and velocity into the deferred targets already used by the scene.

## Carrying a Surface, Not Merely a Position

A portal that transforms only positions works until the first directional quantity appears. Lighting is full of them.

The geometric normal defines the surface orientation. A tangent-space normal map adds detail relative to a tangent and bitangent basis. An anisotropic material may depend on a preferred direction across the surface. Motion blur depends on the direction a point traveled across the screen. Each value must cross the same sequence of coordinate changes as the position, under the transformation law appropriate to that value.

For an arbitrary model matrix $M$, normals transform by the inverse transpose:

$$
N' = (M^{-1})^T N
$$

Using the model matrix directly fails under non-uniform scale because a normal must remain perpendicular to the transformed surface. `GpuInstanceData` stores the instance normal transform as three `vec4` rows. The portal coordinate spaces themselves are rigid, restricted to translation and rotation. Translation does not affect a direction, and for an orthonormal rotation $R^{-1}=R^T$, so the inverse transpose reduces back to $R$.

Helio composes the rotational block at every portal stage:

```wgsl
var space_rot = mat3x3<f32>(
    own_space[0].xyz,
    own_space[1].xyz,
    own_space[2].xyz,
);

space_rot = p2_rotation * space_rot;
space_rot = p1_rotation * space_rot;
space_rot = p0_rotation * space_rot;
```

The final normal matrix becomes the portal-chain rotation multiplied by the instance’s stored inverse transpose. Tangents use the regular upper 3×3 model transform followed by that same rigid chain. After interpolation, the fragment shader orthogonalizes the tangent against the geometric normal, reconstructs the bitangent with the handedness sign, and maps the sampled tangent-space normal into the final folded world frame.

```wgsl
let T = normalize(input.world_tangent
    - dot(input.world_tangent, N_geom) * N_geom);
let B = cross(N_geom, T) * input.bitangent_sign;

N = normalize(
    T * norm_ts.x
    + B * norm_ts.y
    + N_geom * norm_ts.z
);
```

The portal therefore preserves the complete local orientation needed by the PBR material. A brick wall seen through a portal can rotate ninety degrees and its normal map rotates with it. Specular response follows the mapped surface. The light is shading geometry in its final coordinate chart, not illuminating a photograph of geometry rendered somewhere else.

The material path remains concrete. Base color and alpha come from the same material buffers and binding arrays used by ordinary objects. Roughness and metallic values are sampled and clamped. Occlusion strength is applied. Emissive contribution is evaluated. In the specular workflow, dielectric $F_0$ is derived from index of refraction and multiplied by the authored specular color and weight. The resolved RGB $F_0$ is packed across otherwise unused alpha channels in the normal, ORM, and emissive targets.

Portal duplicates currently take the plain default PBR route. The code does not expose the normal G-buffer pass’s Radiant material-graph override, lightmap sampling, or every debug visualization mode. That is an implementation frontier, not a consequence of the spatial model. The duplicate already carries the identifiers, UVs, tangent frame, and material storage needed for the standard surface. Extending feature parity is a matter of sharing or generating more of the material evaluation path.

## Why a Transform Is Still Not Enough

Take an entire room, transform it through a doorway, and rasterize it. The room does not politely limit itself to the doorway’s outline. Its walls can project across the whole screen.

The aperture has to clip the result.

Helio does this in two layers because the outer portal and nested inner portals have different information available.

First, a portal-mask pass rasterizes the physical entry opening from the real camera. The output is a single-channel unsigned integer texture. Zero means no portal. Other pixels contain `portal_view_index + 1`, allowing portal index zero to remain distinguishable from an empty pixel.

That mask captures the exact screen-space silhouette of the opening after projection and ordinary occlusion. A wall standing in front of half the doorway naturally prevents those pixels from being stamped. In the portal fragment shader, the check is early and blunt:

```wgsl
let mask_px    = vec2<i32>(input.clip_position.xy);
let mask_value = textureLoad(portal_mask, mask_px, 0).r;

if mask_value != chain.portals[0] + 1u {
    discard;
}
```

WGSL’s fragment-stage `discard` statement prevents the invocation from updating its attachments ([WGSL `discard` statement](https://www.w3.org/TR/WGSL/#discard-statement)). Here it rejects portal duplicates anywhere outside the visible entry silhouette before the shader performs the full set of PBR texture samples.

The outer stage also checks which side of the portal plane contains the fragment:

```wgsl
let p0_local = p0.inverse_transform
    * vec4<f32>(input.world_position, 1.0);

if p0_local.z > 0.0 {
    discard;
}
```

There is deliberately no outer $X/Y$ extent test. The mask already bounds the view to the actual opening. Adding a rectangular world-space bound would create a tube extending backward from the portal and cut away parts of a larger room that should be visible through perspective. A doorway should show a room, not a doorway-width tunnel.

Nested portals are stranger. The camera cannot directly rasterize the inner opening because it exists only after the first mapping. There is no physical inner surface in the current world to stamp into the outer camera’s mask. Each nested stage therefore carries an intermediate position from the vertex shader and performs a local box test:

```wgsl
fn clip_stage(local: vec4<f32>, half_extent: vec2<f32>) -> bool {
    return local.z > 0.0
        || abs(local.x) > half_extent.x
        || abs(local.y) > half_extent.y;
}
```

For a depth-three chain, the vertex shader records where the point was after the deepest transform and where it was after the middle transform. The fragment shader maps each saved position into that stage’s portal-local frame. A fragment survives only when it sits behind every relevant plane and inside every virtual aperture.

This is the less glamorous half of non-Euclidean rendering. The matrix multiplication creates the illusion. Correct clipping keeps the illusion from spilling all over the frame.

## Why the Outer Portal and Inner Portals Need Different Tests

At first glance, every stage should use the same rectangular test. Transform the point into portal-local coordinates, reject it when it is in front of the plane, and reject it when $|x|$ or $|y|$ exceeds the aperture half-extent. That approach even works in friendly test scenes.

Then the destination space becomes wider than the opening.

Imagine looking through a one-meter doorway into a ten-meter room. At five meters of depth, the visible cone covers more than one meter of the far wall. A world-space rectangular prism extruded backward from the doorway would reject most of that wall. The resulting portal behaves like a long box or tube. Straight corridors whose width matches the portal can hide the error, which makes it particularly easy to ship in an early implementation.

The outer screen-space mask solves the perspective problem exactly at the sample positions that matter. It rasterizes the physical aperture from the current camera, so its silhouette already expands, contracts, skews, and becomes occluded according to the actual view. Portal geometry may spread across the world behind it. Only fragments landing on pixels belonging to the opening survive.

The plane test remains necessary. The mask answers whether a screen pixel looks through the opening. It does not by itself say whether transformed geometry lies on the permitted side of the portal plane. Keeping `p0_local.z <= 0` rejects geometry that crossed into the half-space in front of the boundary.

Inner portals live in a different situation. They are visible only after one or more transitions. The main camera cannot rasterize their physical surface directly into the mask because, in $s_0$, that surface is virtual. Its aperture is a condition inside the composed route. Helio evaluates that condition using the intermediate position saved for the relevant stage.

For the current depth limit, explicit `stage_pos_1` and `stage_pos_2` varyings keep the operation simple. A more general unbounded chain would need another representation, possibly iterative clipping data or precomputed planes carried per chain. The fixed depth lets the shader remain statically shaped, with predictable storage and branches.

The two clipping systems are not redundant. The mask establishes the outer boundary in projected screen space. Per-stage tests establish the validity of the route through virtual inner boundaries. Together, they say both “this pixel sees the entrance” and “this surface legitimately passed through every opening along the path.”

## Depth Is the Real Prize

A portal rendered to a color texture can look convincing, but the texture is still a flat sample unless the engine transports more information and builds special composition logic around it. Helio’s duplicate geometry writes directly into the scene attachments and tests against the real scene depth buffer.

The portal write loads the existing attachments instead of clearing them. In wgpu terms, `LoadOp::Load` preserves an attachment’s prior contents at the beginning of the pass ([wgpu `LoadOp`](https://docs.rs/wgpu/latest/wgpu/enum.LoadOp.html)). Helio follows the G-buffer pass with compatible attachment state and loads its eight targets. Portal fragments then participate in depth testing beside geometry already drawn.

This gives ordinary occlusion the last word. A portal view can disappear behind a foreground object. Geometry seen through the portal can intersect other transformed geometry according to the depth values actually reaching the rasterizer. Deferred lighting receives surfaces, not a pre-lit picture pasted onto a quad.

There is still a portal pipeline and additional rasterization, but it extends the scene’s deferred surface data instead of producing an independent image. The attachments are preserved with `LoadOp::Load`, then the portal duplicates continue writing into them. Whether a backend internally merges compatible API passes is an implementation detail. Helio’s architectural guarantee is stronger than that optimization question: portal geometry lands in the real G-buffer and depth buffer with no intermediate portal color target and no compositing stage.

## Temporal Data Has to Fold Too

The first working portal render is easy to celebrate. Then TAA turns it into a ghostly smear.

Temporal effects need to know where each visible surface was during the previous frame. A current transformed position paired with an untransformed previous position produces a bogus velocity spike. A moving sublevel causes the same problem even when the object itself has not moved locally.

Helio maintains a previous-frame matrix for every coordinate space and composes it through the same chain as the current position:

```wgsl
var pos_prev = own_space_prev
    * (inst.prev_model * vec4<f32>(v.position, 1.0));

if chain.depth >= 2u {
    let p1 = portal_views[chain.portals[1]];
    pos_prev = coordinate_spaces_prev[p1.coordinate_space] * pos_prev;
}

let p0 = portal_views[chain.portals[0]];
pos_prev = coordinate_spaces_prev[p0.coordinate_space] * pos_prev;

let prev_clip = cameras[0].prev_view_proj * pos_prev;
```

Current position goes through current object, space, portal, and camera transforms. Previous position goes through their previous equivalents. The fragment shader converts the previous clip position into pixel coordinates and subtracts it from the current fragment position. That delta enters the same velocity target as the rest of the G-buffer.

Correctly composed motion vectors remove one major source of portal-specific ghosting and one-frame velocity explosions. They do not guarantee perfect TAA. Disocclusion, newly visible recursive layers, mask-edge instability, jitter, and history rejection still exist. Temporal reconstruction always has to decide what to do with pixels that had no meaningful predecessor.

The important structural point is that time follows the same topology as space. Helio stores `coordinate_spaces_prev` beside `coordinate_spaces`. An instance supplies `prev_model` beside its current model transform. The camera supplies `prev_view_proj`. The previous point is not guessed from the portal surface or reconstructed from depth after the fact. It is carried through the previous version of the complete chain.

For a chain $C_0C_1C_2$, the two histories are:

$$
\mathbf{p}_{clip}^{t} = VP^{t}C_0^{t}C_1^{t}C_2^{t}M^{t}\mathbf{v}
$$

$$
\mathbf{p}_{clip}^{t-1} = VP^{t-1}C_0^{t-1}C_1^{t-1}C_2^{t-1}M^{t-1}\mathbf{v}
$$

Every contributor may move independently. The object can animate inside its sublevel. The sublevel can move. A portal mapping can move or rotate. The camera can move. Their combined difference produces the screen-space velocity. This is a much richer answer than assigning the portal polygon’s motion to everything seen inside it.

New visibility still has no previous sample. When a portal edge exposes a surface that was hidden last frame, no transform can manufacture valid color history for that pixel. TAA needs disocclusion detection and history rejection there, just as it does for newly revealed ordinary geometry. The portal system gives it truthful geometry and velocity inputs. Reconstruction policy remains reconstruction policy.

## One Frame, From Scene Data to Lit Portal

It helps to put the pieces back into chronological order.

At the start of a frame, the engine has persistent instance data. Each instance supplies a model matrix, previous model matrix, bounds, mesh ID, material ID, flags, and lightmap index. The flags contain its coordinate-space ID. Separate tables hold current and previous transforms for every active space.

Visibility work reduces the ordinary scene to compacted instance indices. Frustum culling removes objects outside the camera volume. Hi-Z occlusion can remove objects hidden behind already established depth. The regular G-buffer pass consumes the compacted indices through indirect draws and maps each surviving instance through its own coordinate space.

Portal visibility adds another dimension to the selection. The relevant unit is no longer an instance alone. It is an `(instance, chain)` occurrence. The same object may survive for one opening and fail for another. The portal culling pass writes original instance slots, corresponding chain IDs, and indirect counts arranged by draw group.

Before duplicate geometry reaches the G-buffer, the mask pass stamps the visible outer openings into `portal_mask`. Real scene depth participates, so an occluder can cover part or all of an entrance. Every written pixel stores the portal view index plus one.

The portal G-buffer pass begins with the existing attachments loaded. Its indirect stream supplies a compacted occurrence. The vertex shader fetches the original instance, fetches the chain, maps the vertex from its own coordinate space through every transition, transforms its orientation frame, repeats the sequence with previous-frame matrices, and emits intermediate stage positions.

Rasterization interpolates the appropriate outputs across the triangle. The fragment shader checks the screen-space mask, rejects the wrong side of the outer plane, applies the box test for every inner virtual aperture, then evaluates the material. Surviving samples write directly into eight G-buffer attachments, including velocity, while the real depth buffer resolves visibility against surfaces already present.

Deferred lighting later reads those attachments. At that point the source of a surface matters far less. A normal is a normal. Roughness is roughness. Depth is depth. The portal has already done its work by making the surface spatially valid in the observed chart.

That collapse back into the ordinary pipeline is the payoff. The special handling ends before lighting rather than spreading into every screen-space consumer as a portal-texture exception.

## A More Useful Performance Model

Portal rendering discussions often collapse into a false binary. Render-to-texture is described as rendering the whole scene again, while geometry mapping is described as one cheap matrix multiply. Neither model predicts a real frame.

For Helio, a better starting point is the number of surviving `(instance, chain)` occurrences. Let $I_c$ be the set of instances selected for chain $c$. Portal vertex work grows approximately with:

$$
V_{portal} = \sum_{c \in C}\sum_{i \in I_c} V_i
$$

where $V_i$ is the vertex count of instance $i$. The transform cost per vertex also grows with the chain depth, though the current maximum of three makes that factor tightly bounded. Fragments depend on projected coverage, overdraw, depth rejection, and the mask. A large portal showing dense geometry can be expensive. Ten tiny portals whose candidates are mostly culled may be cheap.

The mask helps where fragment shading is costly. A fragment outside the outer aperture is discarded before base color, normal, roughness, occlusion, and emissive texture evaluation. It has still incurred vertex processing and enough rasterization to invoke the fragment stage. The culling pass therefore matters more than hoping the mask will erase arbitrary amounts of work later.

Indirect submission attacks CPU scaling. Without it, the renderer could end up nesting loops over portals, chains, mesh groups, and materials, issuing small draw calls for each combination. Helio instead lets GPU-produced buffers describe the survivors and their draw counts. `multi_draw_indexed_indirect` submits the group commands together. WebGPU and wgpu still validate resource and feature requirements, but the per-occurrence decision remains on the GPU rather than bouncing through the CPU every frame.

Memory traffic has its own shape. The portal shader reads instance data, two coordinate-space tables, portal views, portal chains, compacted indices, compacted chain IDs, materials, texture metadata, texture arrays, and the screen-space mask. Most of those records are small and reused across many vertices or fragments. Access coherence depends on how compaction orders occurrences. Grouping by mesh and material supports indirect drawing, while nearby chain IDs can improve reuse of chain and transform data. Those layout decisions can matter more than shaving one scalar instruction from the shader.

The fixed chain depth makes several costs statically legible. `GpuPortalChain` is sixteen bytes at depth three. The vertex output reserves two extra `vec3` stage positions because the final world position already serves stage zero. Branches test depths two and three directly. No dynamic loop needs to walk an arbitrary buffer of transitions, and interpolator usage has a known ceiling.

That choice spends some work on inactive lanes when a draw contains mixed depths. GPUs execute groups of shader invocations together, so divergent depth conditions may cause both paths to be scheduled within a subgroup. Three short rigid-transform blocks keep the damage bounded. Sorting or grouping occurrences by depth could improve coherence at the cost of more compaction complexity and potentially more draw segmentation. The best answer is empirical and scene-dependent.

Compared with camera recursion, Helio avoids repeating several pieces per portal view. It does not allocate and clear portal color targets, build a second complete G-buffer for each view, run deferred lighting once per portal texture, or sample those lit images during a later composite. It can still transform and rasterize the same visible mesh more than once. The savings come from staying inside one surface-production pipeline and culling occurrences directly, especially when portal coverage is sparse relative to a full auxiliary view.

There are scenes where a texture approach can win. A distant portal updated infrequently can reuse its old image. A portal whose destination contains immense geometry but occupies thirty pixels can render at a tiny resolution. Geometry mapped at the main target resolution cannot exploit temporal reuse in the same way without an additional cache. Helio chooses spatial correctness and pipeline coherence as its baseline. Hybrid policies remain possible if a particular content class needs them.

Measurement should separate the stages. Portal-chain construction, GPU culling, mask rasterization, vertex mapping, fragment rejection, material evaluation, depth behavior, and downstream lighting expose different bottlenecks. Counting portals alone says little. Useful telemetry includes candidate and surviving occurrence counts per chain, triangle counts after culling, projected mask area, fragment invocations, mask rejection rate, depth rejection rate, chain-depth distribution, and bytes read from the compacted buffers.

The renderer can then impose budgets based on work rather than arbitrary portal counts. A recursive chain covering four pixels is harmless. One depth-one opening filling an ultrawide screen can dominate the G-buffer. Projected coverage, visible geometry, and material cost tell the real story.

## The Fourth Coordinate Beyond Rasterization

Once `space_id` is accepted as part of a location, engine APIs have to stop passing naked `Vec3` values where the space is ambiguous.

A ray is not merely an origin and direction. It also begins in $s$. A physics query needs to know which broad phase or collision world contains that origin. If the ray reaches a portal, the engine can terminate, report the boundary, or transform the remaining ray into the adjacent leaf and continue. The renderer’s chain composition has a gameplay analogue.

Velocity has the same issue. A local velocity inside a moving sublevel differs from velocity observed in the parent chart. A character walking forward on a rotating carrier combines its local motion with the carrier’s coordinate-space motion. Crossing a portal rotates the directional component and changes the leaf. Momentum preservation becomes a transition-map rule instead of a teleport special case.

Audio can follow portal paths too. A source at $(x,y,z,s_2)$ may reach a listener in $s_0$ through several openings. Distance and obstruction can be accumulated along a graph route. Direction at the listener comes from the final mapped segment. Reverb belongs to the spaces traversed. Treating the portal as a mere visual surface would leave all of that disconnected.

Navigation naturally splits into local meshes and inter-space edges. Each leaf owns a conventional 3D navigation problem. Portals connect reachable regions between leaves. High-level pathfinding chooses a sequence of transitions, then local solvers find the continuous paths between them. Moving sublevels update edge transforms without forcing every local navigation polygon to be rebuilt in global coordinates.

Networking benefits from the same identity. Replicating `(x,y,z)` without $s$ is insufficient when several spaces reuse local coordinates. Interest management can first select relevant coordinate spaces and portal neighborhoods, then apply metric range inside them. A player may be physically close in raw numbers and completely unreachable because the values belong to different leaves. Another player may be distant in any artificial global embedding yet visible through one portal edge.

Saving and loading also become cleaner. An object stores its local transform and coordinate-space membership. A moving carrier can resume in a new world pose without rewriting the saved transforms of every child. Editor operations can duplicate, move, or stream a sublevel as a unit. The stable local chart becomes an ownership boundary as well as a spatial one.

None of these systems has to copy the renderer’s GPU representation. Physics may maintain separate acceleration structures. Navigation may use a graph. Networking may encode the space as a compact replicated ID. They agree on the semantic invariant: a position is incomplete without its coordinate space, and portals define valid transformations between spaces.

## Debugging Folded Space

Non-Euclidean bugs rarely announce which coordinate frame they came from. A surface appears in the right place but shades as if rotated. A nested portal looks correct head-on and leaks when viewed from the side. Motion vectors explode for one frame when a sublevel moves. The architecture needs visible invariants.

The first useful view is the discrete axis itself. Color every coordinate space by ID. Instances in slot zero receive one color, each sublevel another. When a supposedly isolated object appears in the wrong leaf, the error becomes immediate. Displaying the packed flag value beside a selected object catches CPU and GPU layout disagreement.

Portal chains need similar inspection. A debug overlay can list the outer-to-inner portal IDs, depth, composed transform, and number of surviving occurrences. Rendering each chain with a unique tint reveals when the same instance is duplicated under an unexpected route. A depth-three chain should never read an uninitialized stage position. A depth-one chain should never pay attention to either extra varying.

The mask deserves its own full-screen visualization. Because zero means empty and stored portal IDs are offset by one, an off-by-one error has a recognizable signature: portal zero disappears or empty pixels become portal zero. Showing the integer value as a palette makes overlapping or incorrectly depth-tested aperture stamps visible.

Intermediate positions are another powerful probe. Draw `stage_pos_1` or `stage_pos_2` as transformed points, normals, or false color. The expected invariant is that applying the corresponding portal’s `inverse_transform` places legitimate fragments behind its local plane and inside its half-extents. A matrix-order bug often looks plausible in final world space while becoming obviously wrong in the intermediate chart.

Normals and tangents should be displayed independently. A normal may be correct while a tangent uses an inverse transpose it should not use. The base surface then shades acceptably until a normal map is enabled. Drawing the TBN basis as RGB or short lines catches handedness flips and non-orthogonality before material complexity hides them.

Velocity visualization closes the temporal loop. Static geometry in a moving sublevel should show motion even when its local model matrix is unchanged. Geometry whose current and previous complete chains are identical should show zero apart from camera motion and jitter conventions. A one-frame flash across the velocity target usually means one member of the previous chain was not updated or was indexed differently.

Tests can encode these invariants without relying entirely on screenshots. Compose a known point through one, two, and three synthetic portal matrices and compare the shader-side convention with a CPU reference. Verify matrix order using non-commuting rotations and translations, since pure translations can let reversed multiplication pass. Test a destination room wider than its aperture to prevent the old rectangular-tube bug from returning. Put an occluder across half the outer portal and confirm that the mask, depth, and duplicate draw agree on the covered pixels.

An infinite-tunnel scene remains useful, but it is not sufficient. Its symmetry hides mistakes. Good adversarial scenes use portals of different aspect ratios, off-axis cameras, rotated and moving coordinate spaces, geometry crossing aperture edges, repeated portal IDs inside a chain, animated instances, and destination spaces much wider than their entry openings.

## What This Architecture Buys Us

The largest gain is coherence.

Sublevels and portals both speak in coordinate spaces. The regular G-buffer and portal G-buffer both consume the same instance and material layouts. Visibility is compacted into GPU buffers, then rendered indirectly. Portal surfaces share scene depth instead of arriving later as precomposited color. Motion data follows the same transform chain as position.

It also avoids a class of per-view resources. There is no portal-resolution policy, no render-target pool sized for recursive views, no decision about when an offscreen portal texture should be refreshed, and no texture filtering softening a view just because it passed through an opening. A portal fragment pays for the geometry and material work it actually invokes at the main frame’s sample locations.

The cost profile changes with the architecture.

Visible geometry is duplicated per surviving portal chain. A mesh visible directly and through two portals may be rasterized three times. Fragment `discard` does not refund all earlier vertex and rasterization work, and early rejection behavior varies with shader and hardware. The mask is another attachment to produce and read. Chain data, compacted indices, transforms, and indirect arguments consume bandwidth. Deep recursion is bounded because the work grows with visible `(instance, chain)` pairs even without extra cameras.

Lighting semantics follow directly from treating $s$ as spatial. A light has a coordinate-space address too. The engine can illuminate within a leaf, map selected lights through a portal chain, or combine both under an explicit policy. Shadows, reflections, and global illumination need the same treatment. The code shown here establishes the geometric substrate those systems require: visibility, chart transitions, G-buffer placement, depth, and motion all agree on where the surface is.

Transparent materials are another separate fight. Opaque deferred geometry has a depth buffer and a stable set of G-buffer writes. Transparency depends on ordering, and portals disturb any simple back-to-front order because the visible relation crosses coordinate spaces. The architecture gives us the transforms, apertures, and chains needed to reason about it. It does not make order-dependent blending disappear.

## This Is More Than a Metaphor

“Portal as camera” is a useful recipe for producing an image. “Portal as coordinate mapping” describes the world Helio renders.

The same model covers a moving sublevel, a nested doorway, and an ordinary piece of world geometry. A portal operates on spatial data rather than behaving like a special television embedded in a wall. Once a point has crossed the mapping, the renderer can treat it as a point again. Normals remain normals. Depth remains depth. Velocity comes from two histories of the same mapping.

Helio’s world is $\mathbb{R}^3 \times S$: full three-dimensional geometry distributed across a discrete fourth spatial axis. Portals identify bounded regions of its leaves and supply the transition maps between them. The GPU composes those transitions in WGSL for the instances its visibility pipeline selects, carrying position, orientation, depth, and temporal history across the fold.

Then we clip down the result To the bounds of the viewing plane (the portal itself).
