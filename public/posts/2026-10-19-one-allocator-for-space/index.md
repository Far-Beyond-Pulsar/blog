---
title: "One Allocator for Space: Parent-Relative Worlds, Level Instances, and Portals That Light Themselves"
date: "2026-10-19"
author: ["tristanpoland"]
tags: ["rust", "helio", "scenedb", "rendering", "portals", "sublevels", "wgsl", "architecture", "pulsar"]
description: "A folder in the hierarchy panel that would not move its children turned into a rewrite of how Pulsar represents space. Parent-relative transforms resolved on the GPU, dirty-subtree propagation, camera-relative precision, rigid frames, one allocator behind portals and sublevels, level instances you can drop into a scene, and portals that now take their lighting and their materials from the world they show. This is how each piece works, what we measured, and the places where our own tests lied to us."
thumbnail: /post_thumb/portals-with-mats-in-editor.png
---

A portal in the editor now shows a stretch of another level, and that stretch is lit by the lights standing in that level, shaded by the materials its objects actually use, and placed by a component with four fields. A year of the engine's history is behind that sentence, so this post spends most of its length on what had to be true underneath it.

It started with a folder.

## Part 0: A folder that would not move

The level editor's hierarchy panel let you select several objects, group them into a folder, and drag the folder around. Nothing moved. The folder's gizmo went where you put it and the barrels inside it stayed exactly where they were.

The first fix attempt was the obvious one: when the folder moves, add the same delta to every child. That fix is wrong for a reason that has nothing to do with whether it works. The editor was about to become the only thing in the engine that knew a folder had children. The renderer reads SceneDB columns. It had no idea the folder existed. A thousand objects in a folder would cost a thousand transform writes per drag, each one a dirty row, each one a GPU upload, and a game running the same level would have no folder at all, only a thousand objects that had been rewritten into new places.

The question we ended up asking instead was bigger: **what is a position?** Until then, every `Transform` in SceneDB was a world-space transform. A parent was a label. Moving a parent was an editor convention that someone had to apply to the children by hand.

> If a position is relative to a parent, the folder's matrix is one number the renderer can compose. Moving the folder is one write. The thousand children are untouched.

That is the whole post in one sentence. Everything below is the work needed to make that sentence true for editing, for the file format, for the GPU, for precision, for sublevels, for portals, and for lighting.

### 0.1 What the earlier posts left open

Two earlier posts are the context here. [Sublevels](/blog/2026-08-07-sublevels) described a small GPU table of rigid transforms: every instance renders through an index into it, slot zero is identity, a sublevel claims a slot and tags its members, a portal claims a slot and writes a pair map into it. [Portals Aren't Cameras](/blog/2026-09-18-folding-space) described how a portal duplicates visible geometry through a chain of those spaces and writes it straight into the G-buffer.

That second post ends with a frontier list, and two entries on it are the reason this update exists:

- "Portal duplicates currently take the plain default PBR route. The code does not expose the normal G-buffer pass's Radiant material-graph override."
- "Lighting semantics follow directly from treating s as spatial… The code shown here establishes the geometric substrate those systems require."

Both were honest. Both meant a portal looked right in a demo scene made of flat colors and wrong in a real level. Materials came out flat and metallic. Lights standing in the destination world did nothing, and the lights of the world you were standing in lit the destination as if it were next to you. We will get to both. They were the last two items in a chain of changes, and most of the chain is about how space is represented before it ever reaches a shader.

## Part 1: Parent-relative transforms

### 1.1 The model

`Transform` in SceneDB is now parent-relative: position, rotation and scale in the coordinate system of the object's parent. A root object's parent is the world, so for a root nothing changes.

The scene-model crate keeps the operations that need world space in one place:

- `world_transform_of(world, entity)` composes up the parent chain.
- `set_world_transform(world, entity, transform)` computes the local transform that produces a requested world transform under the current parent chain and writes that.
- `reparent_keeping_world(world, entity, new_parent)` changes the parent and rewrites the local transform so the object does not visibly jump. This is what dragging a barrel from one folder to another does.
- `descendants_of(world, entity)` walks the subtree.

Composition is done in double precision on the CPU (`DMat4`). The world matrix of something deep in a hierarchy is a product of several matrices with potentially large translations, and the only place a rounding error becomes visible is when the result is demoted to `f32` for the GPU. The CPU composes in `f64` and demotes once.

Editing goes through the same functions. The gizmo reads the object's world transform, the user drags, the gizmo writes a world transform, and `set_world_transform` converts it back to a local one. A child inside a moving, rotated folder can still be dragged along world axes because the conversion goes through the parent's inverse.

### 1.2 The file format

Existing levels stored world-space transforms with a parent link that meant nothing numerically. Loading one of those as parent-relative would fling every child into the distance by its parent's offset.

The level file carries a version, and `PARENT_RELATIVE_FILE_VERSION = "2.2"` marks the change. Loading an older file runs `convert_legacy_world_transforms`, which takes each object that has a parent and rewrites its transform from world to local space. A file with no parents loads unchanged. The converter runs once, at load, and the saved file is version 2.2 from then on.

### 1.3 Duplicating and grouping

Two features fell out of the model:

- Duplicating a folder duplicates its contents into a new folder. Each child's local transform is copied as is. The duplicate lands in the right place because its parent did.
- Grouping a selection into a folder preserves world positions. Each member is reparented into the new folder with `reparent_keeping_world`, so nothing appears to move.

Both are a handful of lines each. That is the sign the representation is right.

## Part 2: Resolving the hierarchy on the GPU

Parent-relative storage pushes work somewhere. Somebody has to compose the chain for every object to produce the world matrix the renderer wants. Composing on the CPU every time anything moves would bring back exactly the cost we were trying to avoid.

So SceneDB's derivation layer got a new derivation, `HierarchyResolve`, which runs as a compute pass. Its inputs are the local transform column and a parent column (the parent's entity index plus one, zero for none). Its outputs are rows republished under the packed transform key that existing readers already consume. Joins, culling, the environment join and the shadow passes keep reading a world transform from the place they always read it, and they never learn it was derived.

### 2.1 Two outputs, not one

The resolve pass writes two things per object, and the second is what makes frames work:

```wgsl
// - world: the transform composed through every ancestor, relative to the
//   frame's world origin. What lights, environment volumes and anything else
//   that is not frame-aware read.
// - placement: the transform composed only up to the nearest *rigid frame*
//   ancestor (not including it), plus that frame's slot (the object's space).
//   Objects drawn through the coordinate-space table read this: a frame moving
//   does not change it. For objects with no frame above, placement == world.
```

`world` is what a light needs. A light inside a moving platform needs to know where it is in the world, and it does not know about the coordinate-space table.

`placement` is what a mesh needs when its parent is a rigid frame. The mesh draws through the space table, so its instance matrix has to be relative to the frame and the table supplies the frame's matrix at draw time. If the mesh's own row included the frame's motion, the motion would be applied twice.

This split is why moving a frame is a one-matrix operation. The members' `placement` rows do not change when the frame moves. Only the frame's entry in the table does.

### 2.2 Precision: camera-relative, hi/lo

A large world breaks single-precision floats. At ten kilometers from the origin an `f32` position has about a millimeter of resolution. At a hundred kilometers it has about a centimeter, and vertices visibly swim.

The usual fix is to render camera-relative: subtract the camera's position from everything before it reaches the GPU, so objects near the camera have small coordinates. The engine's GPU side already did that for the main transform path. The new question was where in a hierarchy the subtraction happens.

If you compose a deep hierarchy in `f32` and then subtract the camera, the error is already baked in. If you subtract at the end of the chain, you subtract two large numbers. The shader header states the rule:

```wgsl
// Output rows are relative to the frame's world origin (`origin_hi + origin_lo`,
// zero outside camera-relative frames): the topmost ancestor's position has
// the origin removed *before* anything is added to it, so a nested object far
// from the origin keeps the precision of its offset, not of its distance.
```

The origin is passed as a `hi` and `lo` pair of `f32`s representing a double. The topmost ancestor's position, which is the only large number in the chain, has the origin subtracted first: `(position - origin_hi) - origin_lo`. Each subtraction is exact enough that what is left is small. Every descendant adds a small offset to a small number.

A child at an offset of 1.5 m inside a folder 80 km away therefore keeps the precision of "1.5 m", not of "80 km". It is a one-line rule in a shader and the reason the design works far from the origin.

A marker key, `TRANSFORMS_ORIGIN_RELATIVE_KEY`, tells every consumer that rows are already origin-relative so none of them subtracts twice. The consumers that need it declare their own allowlist: the object-parent and object-frame columns, for instance, are on the camera-relative list.

### 2.3 Dirty-subtree propagation

A scene with a hundred thousand objects where one folder moves should resolve one subtree, not the whole scene.

SceneDB already tracks which rows each column's last flush wrote. The resolve pass consumes that list. The mark entry points set bits in a per-row `changed` word:

```wgsl
const BIT_TRANSFORM: u32 = 1u;
const BIT_PARENT: u32 = 2u;
const BIT_FRAME: u32 = 4u;
```

`cs_mark_transform`, `cs_mark_parent` and `cs_mark_frame` each take the flushed row list for one column and set the matching bit on the rows it names. A parent link change is a different event from a transform change, and a frame change is different again, because they invalidate different outputs.

`cs_resolve_moved` then runs over rows. For each row it asks whether the row or any ancestor changed. That is a walk up the parent chain with a depth cap (`MAX_DEPTH` is 64), looking at the `changed` words. Two questions get separate answers:

- Did anything change that affects the **world** row? Anything on the chain at all.
- Did anything change that affects the **placement** row? Only changes up to the nearest frame, because a frame moving does not move its members' placement.

Rows with no change keep last frame's result.

The second answer feeds a GPU-built list. Every row whose placement was recomposed is appended to a `moved` list as `[count, rows..]`. `cs_finish` turns that count into dispatch arguments, and the scene join's moved-owner path runs as an **indirect dispatch** sized by the moved count. The CPU never reads the count back. A frame where nothing moved dispatches zero workgroups for the join.

This is the same shape as the earlier GPU-driven cull: the CPU says what changed, the GPU decides how much work that implies, and the dispatch size is itself a GPU result.

### 2.4 What this costs, honestly

We have not published a number for the resolve pass at scale, and we are not going to make one up. What we can say is structural: the work is proportional to the number of rows whose chain changed, plus a cheap per-row check whose cost is the chain depth, capped at 64. Moving one folder of a thousand objects touches a thousand rows. A scene that is still touches zero.

## Part 3: A group is a space

Parent-relative transforms make a folder cheap to move. They do not yet make a group of a thousand objects draw through a single matrix, which is what the sublevels post promised and what this design needs to deliver for editor folders as well.

### 3.1 Rigid frames

`RigidFrame` is a marker component. An object with it becomes a **frame**: its subtree draws through one slot of the coordinate-space table instead of through composed per-object matrices.

The hierarchy panel gained "Make Rigid Frame" on folders. A rigid frame is the user-facing name for what Part 2 calls a frame: the folder keeps being a folder, its children keep their local transforms, and the renderer now draws them through the folder's slot.

The trade is that a frame is rigid. Its children are rotated and translated as a block with no shear and no non-uniform scale, which is what the space table has always required. A non-rigid folder resolves with the ordinary world path and costs per-child work when it moves. We chose not to hide that distinction. The menu item says what it does.

Static objects inside a frame are marked movable, because their world position now changes whenever the frame does. A static mesh that cannot move is a promise a frame breaks.

### 3.2 The table the renderer reads

The table is a GPU array of `mat4x4<f32>`. The G-buffer reads it with the current frame and, separately, the previous frame, so a moving frame produces correct velocity vectors and does not smear under temporal anti-aliasing.

An instance's flags carry its space id in bits 8 through 15:

```wgsl
let space_id   = (inst.flags >> 8u) & 0xFFu;
let space      = coordinate_spaces[space_id];
let space_prev = coordinate_spaces_prev[space_id];
```

Eight bits is 256 spaces. The sublevels post described a table of 32 and noted headroom as a future item. The table is now 256 wide, and the G-buffer, the object batch and the portal passes agree on that number. The previous-frame table is a real previous table.

## Part 4: One allocator

Here is where the design changed shape.

Three different features wanted slots in the table: rigid frames, sublevel placements and portal projections. Each had been written to hand out slots its own way. Portals numbered theirs from a local counter. Sublevels reserved a range. Frames took whatever was left. They worked until two of them existed in one scene, at which point they overwrote each other.

We had a conversation that boiled down to a question: why does a portal need anything besides a portal component, and why does a sublevel need anything besides a sublevel component? The honest answer was that each had to know how the table was numbered. That knowledge did not belong to any of them.

### 4.1 Definers

A **space definer** is a registration saying "these entities define spaces":

```rust
inventory::submit! {
    SpaceDefiner {
        name: "level instance",
        entities: roots,
        is_normalized: None,
        normalize: None,
    }
}
```

That snippet is the entire integration for level instances. `entities` is a function returning the entities whose presence implies a space. The registry is built with `inventory`, so a crate registers its definer at link time and nobody keeps a central list. Rigid frames register one, sublevel actors register one, and the level-instance roots in Part 5 register one.

Each defining entity gets a `SpaceSlot { slot }` component. A sync step, `sync_spaces`, assigns slots to definers that lack one, and `needs_space_sync` is a cheap check the frame loop uses to avoid taking a write lock when nothing changed. The slot lands in a GPU row (`object_frame`) so the resolve pass can answer "which frame is above me" without a CPU round trip.

### 4.2 The table and the allocator trait

The CPU builds the matrices with `frame_table(world, origin)`, composing in `f64` and converting at the end, as in Part 1. That gives matrices for everything that defines a space.

Producers that are not entities, notably the portal projection, which creates spaces from pairs of portals each frame, ask for slots through a trait defined in `helio_core`:

```rust
pub trait CoordinateSpaceAllocator {
    fn space_for(&mut self, matrix: Mat4) -> Option<u32>;
}
```

The host implements it with `SpaceTable`. The function returns slot 0 for the identity matrix, returns an existing slot for a matrix it has seen this frame, hands out the next free slot otherwise, and returns `None` when the table is full at 256. Callers treat `None` as a real error rather than wrapping around.

Nothing outside the table numbers anything. A producer cannot overwrite another's slot because it never chooses a slot. The editor, the play-in-editor path and the standalone game each run a `SpaceSync` that builds the table the same way. The standalone game and the editor use the same code and cannot disagree about it.

### 4.3 What it removed

After the allocator, a sublevel actor is a component and a portal is a component. There is no setup call, no slot to claim, no table to register with. Delete the entity and its slot is free next frame. The sublevels post said a portal costs what a moving platform costs. With one allocator that is also true of the code you write to add either.

## Part 5: Level instances

The editor now has a component that displays a whole level inside another.

### 5.1 The idea

The default level, the one you are editing, is already a level instance that nobody thinks about. Its objects are simply the world. A **level instance** generalizes that: a root object, whose transform is the instance's origin, with some other level's objects as its descendants.

An instance can come from two places:

- **From a level file.** `SubLevelDisplayComponent` has an `enabled` flag and a `level` path. When enabled, the file's objects are instantiated under the owner object.
- **In memory.** `create_level_instance` makes a root, and `spawn_in_level_instance` adds objects to it. No file exists. It is a temporary level that lives in the running world and is treated like any other instance.

The root is a space, so the whole instance draws through one matrix. Move the root and the instance moves. Nothing inside it is rewritten.

### 5.2 Loading under an owner

`RuntimeLevel::load_under` loads a level file as the children of an object. Object ids are prefixed with the owner's stable id, `"<owner stable id>/"`, so two instances of the same file never collide and a nested instance gets a longer prefix. The file's root objects are reparented under the owner. Everything inside keeps the local transforms it was authored with, because local transforms are relative to the parent and the parent is now the instance root.

Parent-relative storage is what makes this cheap to build. Loading a level under an owner needs no transform rewriting at all.

### 5.3 Members are not part of the level that shows them

Every object an instance creates is tagged `LevelInstanceMember { root }`. The tag does four jobs:

- **Saving** skips members. A level that displays another does not serialize the other's contents into itself.
- **Undo history** skips members, for the same reason.
- **Grouping** in the hierarchy excludes members. You cannot drag a piece of a displayed level into a folder of the displaying one.
- **The hierarchy** shows the root with a "level instance" badge.

The sync system, `sync_level_instances`, reconciles instances with their display components. Retarget the path and the old members despawn and the new ones spawn. Disable the component and the contents go away. Remove the owner and the instance is removed. A `needs_level_instance_sync` check, like the space one, keeps the steady state free.

Two guards matter. A level that displays itself, directly or through a chain, would recurse forever, so the sync keeps a visited set of normalized paths and a depth cap, and refuses a cycle. And paths are normalized before comparison, because the first cycle test failed on Windows path separators. A cycle written with a backslash looked like a different file from the same cycle written with a forward slash.

### 5.4 Through the editor's command path

Instances are edited by the same command system as everything else. After a command the executor runs a `sync_level_instances` hook, and undo and redo run it too, so undoing a path change brings the previous contents back. The test that covers this runs the whole loop: add a display component, point it at a level, check contents appear and are not in the saved level, duplicate the owner, undo, redo, remove.

One piece is unfinished, and we would rather say so. The component's `level` field is a string path. A typed asset picker that offers only level files needs a `LevelAssetKind` in an external crate, which is not in this change. For now you type or paste the path.

## Part 6: Portals as authored data

The previous design built portal rows from a hand-assembled structure and needed a contiguous block of reserved entities at the bottom of the world to hold them. That worked in the demo. An editor world cannot reserve entities, and nothing about a portal row is really entity data anyway: it is derived from the authored portals each frame.

### 6.1 A component and a Link ID

`PortalComponent` has four fields: `link_id`, `width`, `height`, `enabled`. Two portals with the same `link_id` are partners. Exactly two. One portal with an id is reported as alone, three or more as crowded, and a disabled or hidden portal leaves its partner alone.

We chose Link ID over "pick the other portal from a dropdown" because of what editing a scene looks like. Duplicate a pair and you have four portals with the same id. That is a visible, fixable mistake. A reference to an entity would silently point at the original.

Problems are logged once per standing problem. They are not yet shown in the inspector or the viewport, which is on the list at the end.

### 6.2 A derivation without reserved entities

`PortalProjection` is a SceneDB derivation. The host builds a frame of portal data each frame, `pair_portals` and `build_resolver` produce the pairs and their poses relative to the frame's origin, `PortalProjectionBridge::build_into` resolves chains and takes space slots from the shared table, and the result goes into a shared input. The derivation uploads three buffers it owns and publishes them under the keys the portal passes already resolve:

- `portal_views`, one row per portal view,
- the chain handle table, `[offset, count]` into a pool,
- the chain payload pool, the portal view indices of every chain, back to back.

With no portals nothing is published and the portal passes skip themselves. An unchanged frame compares equal and uploads nothing. The host also tells the renderer how many views and chains are live, so the cull dispatches exactly that many and never a reserved capacity.

The portal's pose is the object's world rotation and translation relative to the origin. Its opening is the component's width and height scaled by the object's world scale. Pose, scale and chains all come from the hierarchy, so a portal parented to a moving rigid frame, which is a door on a train car, works without a special case.

## Part 7: Chains, and the ones nobody can see

This part started as a performance complaint. Looking through portals, and especially with several in view, dropped the frame rate far more than the geometry cost explained.

Every chain redraws the scene it shows. So the question was how many chains we were building.

`PortalProjectionBridge::build_into` resolves chains up to a maximum depth, three by default, over every pair of portals, with no knowledge of the camera. In a scene with two linked portals, A leading to B and B leading to A, every path of length one to three exists: A, B, AB, BA, ABA, BAB. We measured six chains for the pair, in a scene where the camera could see exactly one portal.

There is a camera-aware variant, `build_visible_from_camera_into`. It prunes a branch when the aperture's projected rectangle cannot overlap the view, and rejects apertures whose back faces the camera, using the camera position so the test does not rely on projected winding, which is ambiguous for a portal crossing the near plane. The editor now supplies the camera's view-projection and position to the portal sync each frame and the pruned variant builds the chains.

Same scene, same camera, a portal facing the camera: **one chain** instead of six. A portal facing away produces **zero** chains. That is the correct answer, because from that side the shader's aperture test rejects every fragment anyway.

The change also needed a reorder in the frame setup. Chains depend on the camera, so the camera has to be built before the space sync runs. They were the other way around.

### 7.1 What we did not measure

We profiled the portal passes in a small scene using the renderer's per-pass GPU timestamps. At 256 by 256, with a mesh on each side of a linked pair, the three portal passes together were about 0.01 ms of GPU time, and the whole frame moved from about 0.84 ms to 0.92 ms. Those numbers say the portal passes have no large fixed cost. They say nothing about a full scene at full resolution, where cost scales with the pixels a portal covers and the materials it runs.

We did not chase the full-scene profile further, because the reporter's own test on the real project with the chain pruning in place came back with the frame rate where it should be. We are recording that as an observation, not a benchmark. When we have a representative scene and a repeatable capture, the post that reports it will have real numbers in it.

## Part 8: Lighting through a portal

This is the part we most wanted to get right and the part where the old behavior was most clearly wrong.

### 8.1 The failure

A portal pixel is a surface from another place drawn at a transformed position. The G-buffer pass writes its albedo, normal, roughness and the rest, and deferred lighting then shades it using the position reconstructed from depth. That position is the transformed one, the place where the surface appears in the host world.

So lighting evaluated **the host world's lights at the host position**. A lamp standing next to the content in its own world did nothing, because it was a hundred meters, or a hundred kilometers, from where the pixel appeared. A lamp next to the portal, in the host, lit content that was nowhere near it.

For a sun this mostly hides, because a directional light is the same everywhere. For any local light, a shadowed corner, or a sky that differs between the two places, it is plain wrong.

### 8.2 What the correct answer needs

To shade a portal pixel as if it were in its own world, the lighting needs the pixel's position, normal and the eye position **in the content's world**. Our maps go content to host, so we need the inverse of the composed chain.

For a chain with stages $S_0, S_1, \dots, S_{n-1}$ the vertex shader composes them deepest first, so a content point reaches the host as $S_0 S_1 \cdots S_{n-1}\,p$. The map back is

$$
M_{\text{unmap}} = S_{n-1}^{-1} \cdots S_1^{-1} S_0^{-1}.
$$

Every transform here is rigid, so the inverse is cheap and exact, and normals transform by the rotation part. The eye also maps back. A reflection off a mirror in the content world needs the view vector as the content world sees it.

### 8.3 Telling lighting which chain a pixel belongs to

Deferred lighting needs a per-pixel chain index. The G-buffer already has a channel nothing else was using for these pixels: `lightmap_uv`. A pixel with no lightmap is tagged `(-1, -1)`, a stored voxel `(-1, -2)`, a virtual-geometry pixel `(-2, -2)`. The portal pass now writes:

```wgsl
out.lightmap_uv = vec2<f32>(-1.0, -3.0 - f32(input.chain_idx));
```

The `x` of `-1` keeps "no lightmap" semantics for everything that tests it. The `y` is `-3 - chain`, strictly below the other tags, so the decode is unambiguous:

```wgsl
fn portal_chain_of(lightmap_uv: vec2<f32>) -> i32 {
    if lightmap_uv.x > -1.5 && lightmap_uv.x < -0.5 && lightmap_uv.y < -2.5 {
        return min(i32(round(-3.0 - lightmap_uv.y)), 255);
    }
    return -1;
}
```

The target is `Rg16Float`, which represents integers exactly up to 2048, comfortably above the 256-chain limit.

### 8.4 The unmap table

The per-chain matrices come from the same derivation that publishes the chains. `PortalProjectionInput::set` takes the frame and the host's space table, and for each chain multiplies the inverse of each stage's matrix in order. It publishes them under `portal_chain_unmap`, one `mat4x4` per chain.

The lighting shader binds them as a **uniform**:

```wgsl
@group(0) @binding(11) var<uniform> portal_unmap: array<mat4x4<f32>, 256>;
```

A uniform and not a storage buffer, because the fragment stage was at its storage-buffer limit. The existing code already works around the same limit for the atmosphere by using uniform buffers. 256 matrices is 16 KiB, well inside a uniform binding. The publishing buffer is allocated at that fixed size so the binding is always valid, and the chain cap in the portal sync is the same 256.

Both entry points that need the data, the base lighting pass and the reflection pass, share group 0, so one binding serves both. A fallback buffer of the same size is bound when no portals exist, and it is never read, because only portal pixels index it.

### 8.5 Shading in the content's world

In `fs_main`, once the world position is reconstructed from depth:

```wgsl
var world_pos = world_pos_host;
var N         = N_host;
var eye       = cameras[0].position_near.xyz;
if in_portal {
    let unmap = portal_unmap[portal_chain];
    world_pos = (unmap * vec4<f32>(world_pos_host, 1.0)).xyz;
    N         = normalize((unmap * vec4<f32>(N_host, 0.0)).xyz);
    eye       = (unmap * vec4<f32>(eye, 1.0)).xyz;
}
```

The view vector, the atmosphere's local irradiance, the radiance-cascade lookup and every light distance then use the unmapped values.

Two things in the light loop change for portal pixels. The normal path walks the tile's light list, which was built from the **host** view and says nothing about the content's lights, so a portal pixel instead walks the scene's lights directly, capped at 256. Only pixels inside a portal's footprint pay for that, and they pay a full light loop instead of a short tile list. Second, the stored directional visibility, which comes from the host world's terrain, is skipped for them.

Shadows are the interesting one. We first planned to skip them for portal pixels. Then it became clear that sampling the shadow maps at the **unmapped** position is the correct thing: the shadow atlas holds depth from the real light's point of view, of the real geometry, which includes the content in its real place. The unmapped position is where that geometry lives. So `shadow_factor` is evaluated normally at the unmapped position. The caveat is that a content region far from the host camera may lie outside the sun's cascades or a local light's shadow map, in which case it is lit without shadow. That is an honest limitation, and it shows up as missing shadows and never as wrong light.

The reflection pass applies the same unmapping to position, normal, the view vector and therefore the reflection direction, so the environment sample comes from the content's world. Screen-space reflections and planar reflection hits are skipped for portal pixels, because those textures describe the host's screen and a portal pixel's reflection ray lives somewhere else.

### 8.6 The cost question

The user's reasonable assumption was that this is nearly free, because the geometry is already being duplicated. Half of that is right. The geometry duplication is the expensive part and it already existed. The lighting is additive: portal pixels do extra matrix multiplies (a 4x4 times a point, a 3x3 times a normal, once each for position, normal and eye) and a light loop over all lights instead of a tile's list. Cheap, but not zero, and it scales with the number of lights in the scene, not the number near the pixel. A scene with hundreds of lights and a portal filling the screen would show it. The 256-light cap bounds the worst case.

### 8.7 A test that cannot pass by accident

The test is built so it fails the old behavior. The far portal sits 5000 m from the near one. A point light with a 1200 m range stands beside the **content**, and a second case puts the same light beside the **near portal**, where the content appears. The test compares frame brightness against a dark baseline.

- Light beside the content: **+10.57** brightness over the baseline of 6.45.
- Light beside the portal: **+0.00**.

Correct lighting: the content lights up when its own lamp is on, and does not when only the lamp at the portal's host position is on. We then removed the chain tag from the portal shader to confirm the test could fail. The numbers inverted exactly, `+0.00` and `+10.57`. That inversion is the old bug, reproduced on demand.

## Part 9: Materials through portals

The screenshot that started the second half of this work showed portal content with the right shapes and the wrong surfaces: flat, metallic, ignoring the material.

### 9.1 Two different bugs

The first was small. The portal pass's material bind group was keyed on the texture set's version only. Material rows are SceneDB join output and reallocate as meshes load. A portal draw still bound to the old buffer reads garbage. The main G-buffer pass already keyed on the pair `(texture version, materials buffer epoch)`; the portal pass now does too.

The second was structural, and it is the one the previous post flagged. Look at how the main G-buffer draws:

```rust
for (index, segment) in segments.in_bucket(ShadingBucket::Opaque) {
    let key = RadiantShaderKey {
        template_id: segment.material_class,
        graph_hash: segment.graph_hash,
        feature_flags: 0,
    };
    let pipeline = self.get_or_create_pipeline(&ctx.device, key, "");
    pass.set_pipeline(pipeline);
    segments.draw(&mut pass, index);
}
```

Each material **key**, a class plus the hash of its compiled material graph, has its own pipeline whose shader has the graph's surface code spliced in. A material authored in the material editor is a graph. The portal pass had one pipeline for everything, evaluating the default PBR path. Every graph material fell back to its imported surface: no graph, no textures the graph sampled, and the generic response that reads as metal.

### 9.2 Reusing the main pass's own machinery

The G-buffer solves "draw each material with its pipeline despite readback lag" with **segments**. Occlusion culling keeps a table of every material key it has seen, each assigned a fixed region of an indirect buffer. A GPU compaction step, `compact_ranges`, appends each material range's surviving draws to its key's region and counts them. Passes draw one segment per key at its fixed offset and never need this frame's range layout.

The portal pass already produced an indirect buffer indexed by draw group, so the same compaction applies to it unchanged. Three additions:

1. The segment table is exposed to other passes. `DrawSegments` gained a reference to the GPU table.
2. `PortalCullPass` runs the same compaction shader over its `portal_indirect` into its own buffers, laid out by the G-buffer's table, so a key gets the same region offset and capacity in both. It uses scratch counts of its own, because the object batch's counts are not ours to write.
3. `PortalInstancePass` draws one segment per key, with a pipeline built for that key, falling back to the old single draw until segments exist.

The shared buffers can grow when the G-buffer's table does. They live behind an `Arc<Mutex<..>>` that the cull pass resizes and the instance pass reads, and the draw checks that they are large enough before using them. An early version drew with a 20-byte buffer for a 1280-byte request, and wgpu rejected it with a validation error, which is how we found the size check was missing.

### 9.3 Building a shader per graph

The G-buffer builds a pipeline's shader by taking a template, which is the full G-buffer shader, and splicing the graph's surface code into marked override points. The portal shader is a different file, with a chain-composing vertex stage and a mask-gated fragment stage.

Two changes let it share the mechanism:

- The portal shader now evaluates surfaces the way the G-buffer shader does: a `SurfaceData` struct, `default_pbr_surface`, and `radiant_eval_surface` with the same override markers. It writes subsurface and anisotropy data to the same targets as the main pass, which it previously zeroed.
- `RadiantTemplate::build_shader_source_on` takes the pass's own base shader and applies a template and graph to **that**, instead of to the G-buffer's. For a non-default template it recovers the template's surface function by diffing the template source against the default G-buffer source, splices it into the portal base, and then runs the existing graph-injection logic.

A graph's generated code references `input.world_position`, `input.tex_coords`, `input.world_normal`, `input.clip_position` and `material`. The portal's vertex output provides all of them, plus a `lightmap_uv` varying set to the no-lightmap value, for templates that read it.

Tests validate the generated WGSL with naga for the default path, for a graph shaped like what the material compiler emits, and for every built-in material class. Those tests prove the shader compiles and validates. They do not prove a graph material renders correctly through a portal. That check was the user's, in the editor, and the screenshot at the top of this post is that check passing: a tiled doorway, barrels, cloth and a table, each with its own material, seen through a portal.

### 9.4 What portals still do not do

- Graph `time` nodes read zero in portal content, because the portal pass has no globals. A scrolling or pulsing material is frozen in the portal.
- Only the opaque shading bucket is drawn. A transparent or forward-shaded material is not drawn through portals, where previously it was drawn opaquely and incorrectly.
- Material classes follow the G-buffer, which currently uses the default template for every class unless a shared template registry is wired in. Portals inherit that.

## Part 10: What our tests got wrong

A post about getting things right should include the time we were wrong for a long while.

For most of the lighting work, the diagnostic scenes looked fine. A red mesh through a portal came out red. A sun lit it. Numbers matched the direct view of the same mesh. We had a "content shifts when the far portal moves" mystery on top, where the image changed as the far portal went from 100 m to 200 m and disappeared by 300 m.

The scene had a mesh with a bounding radius of about 173 m, and the far portal 100 m away. The red cube we were admiring through the portal was **the real cube**, visible directly past the portal's edge. It moved out of frame as it was pushed further away because it was being seen directly. The near portal also faced away from the camera, so the shader's front-side test rejected every portal fragment, and the pruned chain builder correctly produced zero chains.

The tests that passed passed for the wrong reason. "Depth differs between linked and unlinked" was true because the editor's portal overlay draws a mask. "Content is red" was true because the content was directly in view.

What we changed:

- The near portal is rotated to face the camera, and the test asserts chains exist.
- The far portal is 5000 m away, so no real object is visible without the portal.
- The lighting test has a positive case and an inverse case, and we verified it fails with the fix removed.
- The measurement we trusted was the one with a control. A number that moves in both directions when you toggle the thing you changed is evidence. A number that looks right is not.

We think this is a general rule for rendering work: a portal test needs a scene where the only way to see the content is through the portal.

## Part 11: Where this leaves the architecture

Take the pieces back as one picture.

- **Space is data on objects.** A transform is relative to a parent. A folder is a transform and children.
- **The GPU composes it.** A resolve derivation turns local transforms into the world and placement rows the rest of the renderer already reads, and does it only for the rows whose chains changed.
- **Precision is a property of where subtraction happens.** The origin is removed from the one large number before small ones are added to it.
- **A group of objects can be one matrix.** A rigid frame is a folder whose subtree draws through one slot.
- **Slots come from one place.** Definers register, a table allocates, producers ask. Portals and sublevels are components.
- **A level is an object with children.** An instance is a root, from a file or from memory, and its members belong to it and not to the level that shows it.
- **A portal is two components with a shared id,** and everything downstream of it is derived.
- **Work follows visibility.** Chains exist for the portals the camera can see.
- **A portal pixel is shaded where it really is.** Position, normal and eye go back through the chain, and the content's own lights, sky and shadows apply.
- **A portal draws with the material the real object uses,** by the same segment mechanism the main pass does.

The last two do not add a special case to the renderer. They remove one. Before, the portal path was a degraded copy of the main path in two dimensions, lighting and materials. Now it shares the main path's machinery and differs only in the geometry it feeds it.

## Part 12: Left for the future

- **Standalone game paths do not prune chains yet.** The editor passes the camera; the embedded and windowed game runners still build every path.
- **No viewport or inspector warning for unpaired portals.** They are logged once.
- **Content is not reloaded when a displayed level file changes on disk.**
- **Typed level picker** needs an asset kind from an external crate.
- **Portal shadows** at the content's real position depend on the host camera's shadow coverage.
- **Transparent and forward materials** are not drawn through portals.
- **Graph time nodes** are frozen in portals.
- **The Helio changes** span several of its crates and need to land in Helio first and then be re-pinned from Pulsar, in that order.

The part we are happiest with is the one we did not plan. We set out to move a folder. The result is that a level can be an object, a portal can be a component, and the renderer is not told about either. It finds a parent link, a table of matrices, and a tag in a texture, and it does the right thing with them.
