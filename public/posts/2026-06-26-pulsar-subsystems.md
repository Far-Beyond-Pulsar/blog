---
title: "Pulsar's Subsystem Architecture: How the Engine Core Ends Up Knowing Nothing"
date: "2026-06-26"
author: "Tristan Poland"
tags: ["rust", "game-engine", "architecture", "reflection", "pulsar"]
description: "A thorough walkthrough of how Pulsar's subsystem and component architecture achieves genuine decoupling — components only import the subsystems they touch, the central engine knows nothing about any of them, and the whole system is open to extension by plugins without modifying engine code."
thumbnail: /post_thumb/engine.png
---

## The Problem With Knowing Too Much

Most game engines end up with a central god-object: an `Engine` or `World` struct that holds references to the renderer, the physics simulation, the audio system, the network layer, and anything else that has ever been needed by any feature. This works fine until the coupling becomes a real problem — when you want to run a headless simulation without the renderer, strip the audio system for a dedicated server build, or let a third-party plugin add a subsystem that the engine code has never heard of. At that point you discover that your central object has tentacles into everything and untangling it is a multi-week project.

Pulsar was designed from the beginning to avoid this. The central engine object — `EngineBackend` — holds nothing but a `SubsystemRegistry` and a `PluginComponentRegistry`. It does not know what a renderer is. It does not know what the physics engine is. It does not know what components exist. All of those things exist in separate crates that depend on `engine_backend`, not the reverse, and they wire themselves in at startup time through the same injection paths that plugins use. When the `sync_component` call comes in for a `LightComponent`, the engine doesn't route it — the component routes itself, reaching into a type-erased context to find and mutate the exact subsystem it knows it needs.

This post explains how that works end to end: from the `Subsystem` trait and registry, through the `ComponentRuntimeBehavior` pattern, to the `get_subsystem!` macro that lets a `LightComponent` touch the renderer without `engine_backend` importing `helio` at all.

---

## The `Subsystem` Trait

The foundation is in `engine_subsystems`, a crate with no engine or UI dependencies — just `std` and `thiserror`. This is important: because it has no dependencies pointing back into the engine, it can be depended on by both the engine crate and by plugin DLLs without creating cycles.

```rust
pub trait Subsystem: Send + Sync + Any {
    fn id(&self) -> SubsystemId;
    fn dependencies(&self) -> Vec<SubsystemId>;
    fn init(&mut self, context: &SubsystemContext) -> Result<(), SubsystemError>;
    fn shutdown(&mut self) -> Result<(), SubsystemError>;
    fn on_frame(&mut self, _delta_time: f32) {}
}
```

The `Any` bound is load-bearing. Without it, a `Box<dyn Subsystem>` would be opaque — you could call `id()`, `init()`, and `shutdown()`, but you could never get back to the concrete type to call `renderer.scene_mut()` or `physics.add_collider()`. With `Any`, a consumer that knows what it's looking for can downcast:

```rust
let ss = registry.get(subsystem_ids::RENDERING).unwrap();
let any: &dyn Any = ss;
let renderer = any.downcast_ref::<helio::Renderer>().unwrap();
```

`SubsystemId` is a newtype over `&'static str` — a constant, human-readable identifier for each subsystem. The well-known IDs are defined as constants so nothing has to match strings at runtime:

```rust
pub mod subsystem_ids {
    use super::SubsystemId;

    pub const PHYSICS: SubsystemId = SubsystemId::new("physics");
    pub const AUDIO: SubsystemId = SubsystemId::new("audio");
    pub const INPUT: SubsystemId = SubsystemId::new("input");
    pub const NETWORKING: SubsystemId = SubsystemId::new("networking");
    pub const SCRIPTING: SubsystemId = SubsystemId::new("scripting");
    pub const RENDERING: SubsystemId = SubsystemId::new("rendering");
    pub const WORLD: SubsystemId = SubsystemId::new("world");
}
```

Plugin subsystems don't need to use these IDs — they can define their own with `SubsystemId::new("com.myplugin.my-subsystem")`. The string just has to be unique among registered subsystems.

---

## The `SubsystemRegistry` and Dependency Resolution

The registry stores all subsystems as `Box<dyn Subsystem>`, fully type-erased:

```rust
pub struct SubsystemRegistry {
    subsystems: HashMap<SubsystemId, Box<dyn Subsystem>>,
    init_order: Vec<SubsystemId>,
    initialized: bool,
}
```

When `init_all` is called, the registry does a topological sort of the registered subsystems using Kahn's algorithm. Each subsystem declares its dependencies via `fn dependencies(&self) -> Vec<SubsystemId>`. The sort produces an initialization order guaranteed to initialize every dependency before the subsystems that depend on it. If a dependency is declared but not registered, or if the dependency graph contains a cycle, initialization fails with a descriptive error rather than silently producing undefined behavior.

```rust
pub fn resolve_dependencies(&self) -> Result<Vec<SubsystemId>, SubsystemError> {
    let mut in_degree: HashMap<SubsystemId, usize> = HashMap::new();
    let mut adjacency: HashMap<SubsystemId, Vec<SubsystemId>> = HashMap::new();

    for id in self.subsystems.keys() {
        in_degree.insert(*id, 0);
        adjacency.insert(*id, Vec::new());
    }

    for (id, subsystem) in &self.subsystems {
        let deps = subsystem.dependencies();
        for dep in &deps {
            if !self.subsystems.contains_key(dep) {
                return Err(SubsystemError::MissingDependency {
                    subsystem: id.as_str(),
                    dependency: dep.as_str(),
                });
            }
        }
        *in_degree.get_mut(id).unwrap() += deps.len();
        for dep in deps {
            adjacency.get_mut(&dep).unwrap().push(*id);
        }
    }

    // Kahn's BFS topological sort...
}
```

Shutdown runs in the reverse of initialization order, which means every subsystem is guaranteed to outlive the subsystems that depended on it. No dangling references, no shutdown ordering bugs.

The registry also supports merging — `registry.merge(other)` absorbs all subsystems from `other` into `self`, silently skipping any ID that already exists. This is the mechanism used to inject plugin subsystems: built-in subsystems are registered first, then plugin subsystems are merged in. Built-in wins.

---

## `EngineBackend`: Knowing Nothing

`EngineBackend` holds a `SubsystemRegistry` and nothing else of significance:

```rust
pub struct EngineBackend {
    subsystems: SubsystemRegistry,
    plugin_components: PluginComponentRegistry,
}
```

It has no fields named `renderer`, `physics`, `audio`, or anything else. It imports none of those crates. Concretely: `engine_backend`'s `Cargo.toml` does not list `helio`, `rapier3d`, or any subsystem-specific crate as a dependency. The only thing it knows about subsystems is that they implement `Subsystem` and can be stored, initialized, and shut down.

All subsystems are injected after construction. The call to `init()` starts with an empty registry:

```rust
pub async fn init() -> Self {
    EngineBackend {
        subsystems: SubsystemRegistry::new(),
        plugin_components: PluginComponentRegistry::new(),
    }
}
```

The `ui_core` crate, which sits above `engine_backend` in the dependency graph and *does* know about specific subsystems, calls `inject_plugin_subsystems` with the list of built-in and plugin-provided subsystems after loading is complete:

```rust
pub fn inject_plugin_subsystems(
    &mut self,
    subsystems: Vec<Box<dyn engine_subsystems::Subsystem>>,
) -> Result<(), SubsystemError> {
    let context = SubsystemContext::new();

    for mut ss in subsystems {
        let id = ss.id();
        match self.subsystems.register_boxed(ss) {
            Ok(()) => {
                let ss = self.subsystems.get_mut(id).unwrap();
                ss.init(&context)?;
            }
            Err(SubsystemError::AlreadyRegistered(_)) => { /* built-in wins */ }
            Err(e) => return Err(e),
        }
    }

    Ok(())
}
```

Each subsystem is initialized individually as it arrives. This means subsystems from a plugin DLL are initialized with the same call sequence as built-in subsystems, and the registry doesn't care which is which.

---

## `ComponentRuntimeBehavior`: Self-Contained Component Logic

The bridge between components and subsystems is the `ComponentRuntimeBehavior` trait in `pulsar_reflection`:

```rust
pub trait ComponentRuntimeBehavior {
    const CLASS_NAME: &'static str;

    fn sync_component(
        owner: &RuntimeComponentOwner,
        component_index: usize,
        component_data: &Value,
        context: &mut dyn ComponentRuntimeContext,
    );
}
```

And the context it receives:

```rust
pub trait ComponentRuntimeContext {
    fn subsystems_mut(&mut self) -> &mut Subsystems;
    fn project_root(&self) -> &std::path::Path;
    fn report_error(&mut self, message: String);
}
```

`Subsystems` here is the per-sync-pass type-erased map of registered subsystems — the same concept as `SubsystemRegistry` but scoped to the component runtime:

```rust
pub struct Subsystems {
    owned: HashMap<TypeId, Box<dyn Any>>,
    borrow: HashMap<TypeId, *mut ()>,
}

impl Subsystems {
    pub fn register<T: 'static>(&mut self, subsystem: T) { ... }
    pub fn register_ref<T: 'static>(&mut self, subsystem: &mut T) { ... }
    pub fn get_mut<T: 'static>(&mut self) -> Option<&mut T> { ... }
}
```

This map is populated before the sync pass by the concrete context implementation (which lives in `engine_backend` and *does* know about specific subsystems). The component's `sync_component` function sees only `&mut dyn ComponentRuntimeContext` — it has no idea which concrete context it's running inside, which means the same component code runs identically in the editor's live preview, in a standalone game build, and in a headless simulation.

---

## `get_subsystem!`: The Ergonomic Glue

Reaching into `context.subsystems_mut().get_mut::<SomeType>()` everywhere is verbose and produces a messy error message when the subsystem isn't found. The `get_subsystem!` macro wraps this into a one-liner that panics with a descriptive message naming the missing type:

```rust
#[macro_export]
macro_rules! get_subsystem {
    ($ctx:expr, $ty:ty) => {
        $crate::ComponentRuntimeContext::subsystems_mut(&mut *$ctx)
            .get_mut::<$ty>()
            .expect(concat!("Subsystem `", stringify!($ty), "` is not registered"))
    };
}
```

In practice this reads like accessing a field. The `LightComponent`'s `sync_component` implementation is the most direct illustration of the whole pattern:

```rust
use helio::{GpuLight, LightType as HelioLightType, SceneActor, Renderer};
use pulsar_reflection::{get_subsystem, ComponentRuntimeBehavior, ComponentRuntimeContext, RuntimeComponentOwner};

#[register_runtime_behavior]
impl ComponentRuntimeBehavior for LightComponent {
    const CLASS_NAME: &'static str = "LightComponent";

    fn sync_component(
        owner: &RuntimeComponentOwner,
        _component_index: usize,
        component_data: &Value,
        context: &mut dyn ComponentRuntimeContext,
    ) {
        let light = Self::from_component_data(component_data);
        if !light.general.enabled { return; }

        let gpu = GpuLight {
            position_range: [owner.position[0], owner.position[1], owner.position[2], light.attenuation.range],
            color_intensity: [light.color.color[0], light.color.color[1], light.color.color[2], light.intensity.intensity],
            shadow_index: if light.shadows.cast_shadows { 0 } else { u32::MAX },
            light_type: HelioLightType::Point as u32,
            // ...
        };

        let tag = scene_id_to_tag(owner.scene_object_id);
        let renderer = get_subsystem!(context, Renderer);
        renderer.scene_mut().insert_actor(SceneActor::light_with_tag(gpu, tag));
    }
}
```

The crate `pulsar_rendering` — which contains `LightComponent` — imports `helio` directly. It uses the renderer's full API. But it doesn't import `engine_backend`. It doesn't know that there is a `PhysicsEngine` or an `AudioSystem`. It knows exactly one subsystem — `Renderer` — and it imports exactly one subsystem crate. The `#[register_runtime_behavior]` attribute emits an `inventory::submit!` block that registers this `sync_component` function with the global inventory, making it available to the engine at runtime without any registration table to maintain.

The physics component does the same, but for the physics engine:

```rust
// In pulsar_physics — imports rapier3d, not helio

#[register_runtime_behavior]
impl ComponentRuntimeBehavior for RigidbodyComponent {
    const CLASS_NAME: &'static str = "RigidbodyComponent";

    fn sync_component(
        owner: &RuntimeComponentOwner,
        _component_index: usize,
        component_data: &Value,
        context: &mut dyn ComponentRuntimeContext,
    ) {
        // deserialize the component, call get_subsystem!(context, PhysicsEngine), etc.
    }
}
```

`pulsar_physics` knows nothing about `helio`. `pulsar_rendering` knows nothing about `rapier3d`. Both know exactly the subsystems they need and nothing more.

---

## How `StaticMeshComponent` Touches Multiple Subsystems

The most realistic component is `StaticMeshComponent`. A mesh component needs to load mesh geometry (potentially hitting disk), upload it to the GPU (through the renderer), cache the result (to avoid re-loading on every frame), and track which scene objects are alive (for stale-entry cleanup). That requires four separate subsystems: `Renderer`, `MeshCache`, `SceneObjectCache`, and `LiveKeySet`.

```rust
fn sync_component(
    owner: &RuntimeComponentOwner,
    _component_index: usize,
    component_data: &Value,
    context: &mut dyn ComponentRuntimeContext,
) {
    let mesh_asset = /* read from component_data */;

    // Phase 1: check whether the mesh is already cached
    let cached = {
        let mc = get_subsystem!(context, MeshCache);
        mc.get(&abs_path)
    };

    let (mesh_id, mat_id) = if let Some(ids) = cached {
        ids
    } else {
        // Cache miss — load and upload
        let upload = load_mesh_upload(path).unwrap();
        let renderer = get_subsystem!(context, Renderer);
        let mid = renderer.scene_mut()
            .insert_actor(SceneActor::mesh(upload))
            .as_mesh()
            .unwrap();
        let matid = renderer.scene_mut().insert_material(default_material());

        let mc = get_subsystem!(context, MeshCache);
        mc.insert(abs_path.clone(), (mid, matid));
        (mid, matid)
    };

    // Mark this scene object as live so stale-cleanup keeps it
    get_subsystem!(context, LiveKeySet).insert(scene_id.to_string());

    // Phase 2: update or insert the scene object, delta from the cache
    let action = {
        let oc = get_subsystem!(context, SceneObjectCache);
        determine_action(oc, scene_id, mesh_id, mat_id, transform)
    };

    match action {
        SceneCacheAction::UpdateTransform { obj_id } => {
            get_subsystem!(context, Renderer)
                .scene_mut()
                .update_object_transform(obj_id, transform);
        }
        SceneCacheAction::Insert { .. } => {
            let id = get_subsystem!(context, Renderer)
                .scene_mut()
                .insert_actor(SceneActor::object(descriptor))
                .as_object()
                .unwrap();
            get_subsystem!(context, SceneObjectCache)
                .insert(scene_id.to_string(), id, abs_path);
        }
    }
}
```

The key discipline here is that each `get_subsystem!` call must be in its own scope. `get_subsystem!` calls `subsystems_mut()`, which takes a mutable borrow on the context. Two simultaneous borrows would violate the borrow checker. The solution is to extract what you need from each subsystem into a local variable before accessing the next one. The borrow ends when the block ends. This is not a workaround — it's the borrow checker correctly enforcing that you can't simultaneously hold a mutable reference to the mesh cache *and* the renderer, which would be genuinely problematic if both were behind the same lock.

`MeshCache`, `SceneObjectCache`, and `LiveKeySet` are themselves simple types — `HashMap` wrappers, essentially — that happen to be registered as subsystems so they can be shared between the context and the component without passing them as explicit parameters. The context registers them before the sync pass starts; the component retrieves them by type during the sync pass.

---

## Plugin Subsystems

Plugins participate in this system on equal footing with built-in subsystems. A plugin DLL that wants to add a custom audio subsystem implements the `Subsystem` trait from `engine_subsystems`:

```rust
// In a plugin DLL

pub struct MyAudioSubsystem {
    device: Option<AudioDevice>,
}

impl Subsystem for MyAudioSubsystem {
    fn id(&self) -> SubsystemId { SubsystemId::new("com.myplugin.audio") }

    fn dependencies(&self) -> Vec<SubsystemId> {
        vec![subsystem_ids::WORLD]  // needs world to be ready first
    }

    fn init(&mut self, _context: &SubsystemContext) -> Result<(), SubsystemError> {
        self.device = Some(AudioDevice::open()?);
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), SubsystemError> {
        self.device.take();
        Ok(())
    }

    fn on_frame(&mut self, _dt: f32) {
        if let Some(dev) = &mut self.device {
            dev.tick();
        }
    }
}
```

The plugin's `EditorPlugin::subsystems()` method returns this as a `Vec<Box<dyn Subsystem>>`. At engine startup, `PluginManager` collects the subsystems from all loaded plugins and passes them to `EngineBackend::inject_plugin_subsystems`. They are registered, dependency-sorted, and initialized through the same path as built-in subsystems. The `on_frame` method gets called every game tick in init order.

A plugin component can then reach this subsystem through `get_subsystem!` just like a built-in component reaches the renderer:

```rust
// In a plugin component in the same or a different DLL

let audio = get_subsystem!(context, MyAudioSubsystem);
audio.play_sound(sound_id, owner.position);
```

The engine doesn't need to know about `MyAudioSubsystem`. The component crate and the subsystem crate can be in the same plugin DLL or in different ones. The context carries them by `TypeId`, and `get_subsystem!` retrieves by `TypeId`. As long as the plugin is loaded before the sync pass starts, it works.

---

## Plugin Components

Plugin components go through a parallel registration path via `PluginComponentRegistry`. A plugin component is anything that implements `EngineClass` (giving it the full reflection system: properties panel, serialization, blueprint methods) and also implements `ComponentRuntimeBehavior` (giving it runtime sync behavior). The plugin's `EditorPlugin::components()` method returns a list of `(class_name, factory)` pairs:

```rust
fn components(&self) -> Vec<(String, ComponentFactory)> {
    vec![
        ("MyAudioSourceComponent".to_string(), Box::new(|| Box::new(MyAudioSourceComponent::default()))),
    ]
}
```

These factories are registered in `PluginComponentRegistry`. When the editor opens a scene and encounters a component whose class name matches a plugin component, it creates an instance via `create_instance(name)` and that instance provides full `get_properties()` metadata for the panel, full serialization for the scene file, and calls `sync_component` during the runtime pass to push state to the plugin subsystem.

What this means architecturally is that you can build an entirely self-contained plugin that:

1. Defines a subsystem (an audio engine, a procedural terrain system, a network voice layer)
2. Defines components that use that subsystem via `get_subsystem!`
3. Defines custom property editor types for those components' fields via `pulsar_type!`
4. Ships as a single DLL

The engine loads the DLL. The subsystem is injected. The component class appears in the Add Component menu. The properties panel shows the component's reflected properties with custom editors. The scene file serializes and deserializes the component data. The runtime sync pass calls the component's behavior and it reaches the subsystem. The editor knows nothing about any of this beyond the `EditorPlugin` interface.

---

## The `ScenePropsProjector` Side Channel

There is one more integration point between components and the engine worth mentioning: `ScenePropsProjector`. Some scene-level data — like the mesh path for a `StaticMeshComponent` — needs to be visible to systems that process the scene as a whole rather than to the renderer specifically. For instance, the scene snapshot that gets passed to the Helio renderer needs a unified `props` map per object that aggregates contributions from all attached components.

```rust
pub trait ScenePropsProjector {
    const CLASS_NAME: &'static str;

    fn apply_scene_props(
        props: &mut HashMap<String, Value>,
        component_data: Option<&Value>,
    );
}
```

A component that implements this trait — and marks itself with `#[register_scene_props_applier]` — contributes to the per-scene-object props map during the snapshot pass. `StaticMeshComponent` uses this to surface the `mesh_asset` path:

```rust
#[register_scene_props_applier]
impl ScenePropsProjector for StaticMeshComponent {
    const CLASS_NAME: &'static str = "StaticMeshComponent";

    fn apply_scene_props(props: &mut HashMap<String, Value>, component_data: Option<&Value>) {
        props.remove("mesh_asset");
        let Some(data) = component_data else { return };
        if let Some(path) = data.as_object()
            .and_then(|o| o.get("mesh_asset"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
        {
            props.insert("mesh_asset".to_string(), Value::from(path));
        }
    }
}
```

The scene snapshot system calls `apply_scene_props_for_class(class_name, &mut props, component_data)`, which iterates the inventory of registered `ScenePropsApplierRegistration` entries to find the right handler. Again, no central list. The component registers itself at startup, and the scene system dispatches to it at runtime by class name.

---

## The Dependency Graph in Practice

To make concrete what "the engine knows nothing" actually means at the crate level, here's a simplified view of which crates import which:

- `engine_subsystems` — no engine deps, just `std` and `thiserror`. Defines `Subsystem`, `SubsystemRegistry`, `SubsystemId`.
- `pulsar_reflection` — no renderer or physics deps. Defines `EngineClass`, `ComponentRuntimeBehavior`, `Subsystems`, `get_subsystem!`.
- `engine_backend` — depends on `engine_subsystems` and `pulsar_reflection`. Defines `EngineBackend` with an empty `SubsystemRegistry`. Does NOT depend on `helio`, `rapier3d`, or any component crate.
- `pulsar_rendering` — depends on `helio` and `pulsar_reflection`. Defines rendering components. Does NOT depend on `engine_backend` or `rapier3d`.
- `pulsar_physics` — depends on `rapier3d` and `pulsar_reflection`. Defines physics components. Does NOT depend on `engine_backend` or `helio`.
- `ui_core` — the application root, depends on everything. Responsible for constructing the subsystems, injecting them into `EngineBackend`, and wiring up the sync passes.

The knowledge boundary is enforced by the Rust compiler. `engine_backend` cannot accidentally call `renderer.scene_mut()` because it doesn't have `helio` in its dependency tree. If someone tries to add that import, the build fails. The architecture is not just a convention — it's a compiler-checked invariant.

---

## The Sync Pass: Putting It All Together

At runtime, a sync pass looks roughly like this. The context is built with the registered subsystems. The scene database is iterated. For each scene object, for each attached component, the engine calls `apply_runtime_behavior_for_class(class_name, &owner, index, &data, &mut context)`. This function iterates the `RuntimeBehaviorRegistration` entries collected from every loaded crate via `inventory::iter` and dispatches to the matching `sync_component` function.

The engine — concretely, the code that calls `apply_runtime_behavior_for_class` — doesn't know what `LightComponent` is. It doesn't know what `StaticMeshComponent` is. It knows there is a function registered under the string `"LightComponent"` and a function registered under `"StaticMeshComponent"`, and it calls them with the current component data and a context that carries the subsystems. Those functions reach into the context with `get_subsystem!`, pull out the concrete subsystem they need by type, and do their work. The engine is a dispatch table and a context carrier. What happens inside each `sync_component` is entirely the business of the component and the subsystem it was written to use.

The result is that every new component type, every new subsystem, and every new plugin is self-contained and additive. Nothing in the engine is modified. Nothing in the editor is modified. The inventory collects the new entries at startup, the registry accepts the new injection, and the sync pass dispatches correctly on the first run. The engine truly ends up knowing nothing — and that's exactly the point.
