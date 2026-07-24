---
title: "Type-Agnostic Reflection: How Pulsar's Property Editors Shed JSON, Became Entities, and Stopped Knowing What They Were Editing"
date: "2026-07-23"
author: ["tristanpoland"]
tags: ["rust", "reflection", "editor", "pulsar", "architecture"]
description: "How Pulsar's property editor system evolved from JSON-mediated stateless function pointers to entity-based factories with type-erased value channels — and why eliminating type knowledge from the framework layer made the entire editor registry extensible without per-type boilerplate."
thumbnail: /post_thumb/reflection2.png
---

## The Old Model: JSON In, Elements Out

Pulsar's property system started with a straightforward premise: each type registers an editor function, and the properties panel calls that function with the current value (serialized as JSON) and gets back a GPUI element to render. The editor was a pure function — `fn(&PropertyEditorArgs) -> AnyElement` — with no state, no lifecycle, and no ownership of widgets.

The `PropertyEditorArgs` struct carried everything the editor might need:

```rust
pub struct PropertyEditorArgs<'a> {
    pub id_prefix: &'a str,
    pub class_name: &'a str,
    pub display_name: &'a str,
    pub prop_name: &'a str,
    pub type_info: &'static RuntimeTypeInfo,
    pub current_json: &'a Value,           // ← JSON serialized value
    pub current_value: &'a dyn Any,        // ← typed path
    #[cfg(feature = "prims-gpui")]
    pub on_bool_toggle: Option<...>,        // ← type-specific callback
    #[cfg(feature = "prims-gpui")]
    pub on_enum_select: Option<...>,        // ← type-specific callback
}
```

Two value channels (`current_json` and `current_value`). Two type-specific callback slots (`on_bool_toggle`, `on_enum_select`). The `PropertyEditorRegistry` was a `HashMap<TypeId, PropertyEditorFactory>` where each factory received this struct and returned an element. Editors dug into `current_json` to read the value, and called `on_bool_toggle` or `on_enum_select` to push changes back.

This worked, but it encodes type knowledge in the framework layer. The properties panel — which should be completely generic — had to know that booleans use `on_bool_toggle` and enums use `on_enum_select`. Every new type category required a new callback slot. The `PropertyEditorArgs` struct grew with each type category added.

Worse, editors were stateless. They couldn't own widgets. A bool editor that wanted to render a toggle button had to build the button fresh every frame, because the editor function was called, returned an element, and disappeared. Child entity ownership, subscriptions, and focus state all had to be managed externally through an init-hooks system that added another layer of inventory registration.

The init-hooks system (`UiPropertyEditorInitHint`) was a separate inventory path where editors registered initializer functions that the framework called once to create widget entities. The editor function would then receive a handle to those entities via the args. Two registration paths per editor. Two inventory submissions. A constant dance between "init" and "render" phases.

---

## Phase 1: One Value Channel

The first step was collapsing the two value channels into one. `current_json` was vestigial — once editors had typed `current_value`, most of them stopped reading from JSON. The field was always `Value::Null` in practice. Removing it cleaned up a dead second path that invited editors to reach for serialization instead of downcasting.

The commit message says it plainly:

> The field was always `Value::Null` after editors moved to typed values, so it was a dead second value channel that invited editors to reach for JSON instead of downcasting. `current_value` is now the only way in; serialisation stays the data source's concern.

One value channel. One direction. The editor receives `&dyn Any` and downcasts to its own type. JSON encoding and decoding happens only at the system boundary — the scene database produces JSON, the properties panel deserializes it into `Box<dyn Any>`, and the editor receives a typed reference. The reverse path is the same: the editor hands back `Box<dyn Any + Send>`, the panel serializes it to JSON, the scene database stores it.

This was the prerequisite for everything that followed. With one value channel, the editor contract was simple enough that the next step — making editors into entities — became tractable.

---

## Phase 2: Editors Become Entities

The init-hooks system existed because editors couldn't own their own state. A widget that needed `InputState`, `NumberInput`, or `DropdownMenu` had to pre-create these entities in an init hook, store them somewhere the framework could find them, and then receive handles back during render. The init hook and the render function were separate code paths registered at separate times.

The refactor eliminated this entirely. Each editor became a GPUI entity — a struct implementing `Render`, with its own fields, its own child entities, and its own subscriptions. The factory function changed from returning an element to returning a `BoundPropertyEditor`:

```rust
pub struct BoundPropertyEditor {
    /// Type-erased renderable handle to the editor entity.
    pub view: gpui::AnyView,
    /// Push a fresh value into the editor. A no-op if the value is unchanged.
    pub set_value: Arc<dyn Fn(&dyn Any, &mut gpui::Window, &mut gpui::App) + Send + Sync>,
}
```

A `BoundPropertyEditor` is two things: a renderable view handle (the entity) and a value-setter closure. The framework caches one of these per `(class_name, property_name)` pair. On construction, the factory creates the entity and returns the bound handle. On every subsequent render, the framework calls `(editor.set_value)(current_value, window, cx)` to push the latest value in.

The editor's `set_value` closure is generated by `BoundPropertyEditor::new`, which takes the entity and a typed setter:

```rust
impl BoundPropertyEditor {
    pub fn new<T, V>(
        entity: gpui::Entity<V>,
        set: impl Fn(&mut V, &T, &mut gpui::Window, &mut gpui::Context<V>) + Send + Sync + 'static,
    ) -> Self
    where
        T: 'static,
        V: gpui::Render,
    {
        let for_set = entity.clone();
        Self {
            view: entity.into(),
            set_value: Arc::new(move |value, window, cx| {
                let Some(typed) = value.downcast_ref::<T>() else { return; };
                for_set.update(cx, |editor, cx| set(editor, typed, window, cx));
            }),
        }
    }
}
```

The typed setter is called **only** when the `&dyn Any` actually holds a `T`. The downcast guard means editors never write downcasting boilerplate — they just handle `&f32`, `&bool`, or whatever their concrete type is. The type erasure is handled once, in `BoundPropertyEditor::new`.

The old init-hooks inventory path was removed. Editors now create their own child entities in their constructor:

```rust
impl BoolEditor {
    fn new(args: &PropertyEditorArgs<'_>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let value = args.current_value.downcast_ref::<bool>().copied().unwrap_or(false);
        // Create child entities, register subscriptions, set initial value...
        Self { label, toggle, value, write_back, _subs }
    }
}
```

Factory functions became minimal:

```rust
fn bool_editor(args: &PropertyEditorArgs<'_>, window: &mut Window, cx: &mut App) -> BoundPropertyEditor {
    let entity = cx.new(|cx| BoolEditor::new(args, window, cx));
    BoundPropertyEditor::new(entity, |editor: &mut BoolEditor, value: &bool, _window, cx| {
        if editor.value != *value { editor.value = *value; cx.notify(); }
    })
}
```

The `PropertyEditorFactory` type alias encodes the contract:

```rust
pub type PropertyEditorFactory =
    fn(&PropertyEditorArgs<'_>, &mut gpui::Window, &mut gpui::App) -> BoundPropertyEditor;
```

Take args, build an entity, return a `BoundPropertyEditor`. No init hooks. No JSON. No type-specific callback slots.

---

## Phase 3: The Framework Stops Knowing About Types

With editors as entities and a single typed value channel, the framework layer — `render_property_row_runtime` in `ui_common` — became completely type-agnostic:

```rust
pub fn render_property_row_runtime<V: 'static>(
    state: &mut PropertyStateManager,
    id_prefix: &str,
    class_name: &str,
    display_name: &str,
    prop_name: &str,
    type_info: &'static RuntimeTypeInfo,
    current_value: &dyn Any,
    write_back: Arc<dyn Fn(Box<dyn Any + Send>, &mut Window, &mut App) + Send + Sync>,
    window: &mut Window,
    cx: &mut Context<V>,
) -> AnyElement {
    let Some(factory) = PROPERTY_EDITOR_REGISTRY.get(type_info.type_id) else {
        return div().text_sm().child("(nyi)").into_any_element();
    };
    let key = (class_name.to_string(), prop_name.to_string());
    let editor = match state.editors.get(&key) {
        Some(editor) => editor.clone(),
        None => {
            let args = PropertyEditorArgs { id_prefix, class_name, display_name, prop_name, type_info, current_value, write_back };
            let editor = factory(&args, window, cx);
            state.editors.insert(key, editor.clone());
            editor
        }
    };
    (editor.set_value)(current_value, window, cx);
    editor.view.into_any_element()
}
```

This function does not know what `type_info` describes. It does not branch on `TypeStructure::Enum` or `TypeStructure::Primitive`. It does not check whether the property is a boolean, a float, a string, or a colour. It finds the factory by `TypeId`, builds or retrieves the editor, pushes the value, and returns the view. That is the entire extent of its knowledge about the property.

The `PropertyEditorRegistry` confirms this. It's a single `HashMap<TypeId, PropertyEditorFactory>`, populated from `inventory::collect!(UiPropertyEditorHint)` at startup. No type-specific dispatch. No special cases.

```rust
pub struct PropertyEditorRegistry {
    factories: HashMap<TypeId, PropertyEditorFactory>,
}
```

Every editor — whether for `f32`, `bool`, `String`, `LightType`, or `[f32; 3]` — is registered as a `UiPropertyEditorHint` linking its `TypeId` to a factory function. The framework never distinguishes between them.

---

## The TypeId Trick That Made Enum Editors Generic

With the framework fully type-agnostic, the next problem became clear: enums were the only types without editors. `#[derive(Reflectable)]` registered them with the runtime type registry (for JSON serialization) but never submitted a `UiPropertyEditorHint`. The `PropertyEditorRegistry` had no entry for `TypeId::of::<LightType>()`, so the panel rendered `"(nyi)"`.

The fix was a single addition to the derive macro:

```rust
inventory::submit! {
    UiPropertyEditorHint {
        type_id: TypeId::of::<LightType>(),
        fn_ptr: erase_property_editor_fn_ptr(enum_dropdown_editor),
    }
}
```

Every `#[derive(Reflectable)]` on an enum now auto-registers a generic dropdown editor. The editor itself (`enum_dropdown_editor`) is completely type-agnostic — it serializes the current value to JSON via `RUNTIME_TYPE_REGISTRY.serialize_json_for_any`, extracts the variant index, renders a dropdown with the variant names from `type_info.enum_variants()`, and on selection deserializes the index back into the concrete enum type via `deserialize_json_for_type`.

```rust
let value = RUNTIME_TYPE_REGISTRY
    .serialize_json_for_any(args.current_value)
    .ok()
    .and_then(|v| v.as_u64())
    .unwrap_or(0);

// On dropdown click:
let json = serde_json::json!(selected_ix as u64);
if let Ok(val) = RUNTIME_TYPE_REGISTRY
    .deserialize_json_for_type(type_info, json)
{
    (write_back)(val, window, cx);
}
```

This pattern was already possible with the old architecture, but it would have required adding `on_enum_select: Option<fn(usize)>` to `PropertyEditorArgs` and maintaining a separate dispatch path. With the type-agnostic architecture, it falls out naturally: the generic editor serializes and deserializes through the same runtime registry that handles all type-specific logic. The framework never needs to know that `LightType` is an enum — it just passes `&dyn Any` and `write_back` around.

---

## The f64 Gap

The import configurator (for model files dropped into the content drawer) uses an import-options schema from the model-loader crate. One option kind is `Float { min, max, step }`, whose constraints are `Option<f64>`. The code that converts schema fields into `ImportField` instances does:

```rust
OK::Float { min, max, step } => (
    RUNTIME_TYPE_REGISTRY.get::<f64>().expect("f64 registered"),
    FieldConstraints { min: *min, max: *max, step: *step },
),
```

This panics. `f64` was never registered as a primitive type. The `prims/core/` directory had `f32`, `i32`, `i64`, `u64`, `bool`, `[f32; 3]`, and `[f32; 4]`. No `f64`.

The fix was adding the missing file, following the same pattern as `f32`:

```rust
#[pulsar_type(
    serialize_json_with = serialize_f64_json,
    deserialize_json_with = deserialize_f64_json,
    editor = f64_editor
)]
type RegisteredF64 = f64;
```

The gap existed because there was no automated check that every Rust primitive has a reflection counterpart. The import schema was the first system that needed an `f64` in the property pipeline, and the first system that failed because of it.

---

## What Changed

The architectural evolution crossed three boundaries:

| Layer | Before | After |
|---|---|---|
| Editor identity | Stateless function pointer | Entity with lifecycle, children, subscriptions |
| Editor registration | Factory returning element | Factory returning `BoundPropertyEditor` (entity + value-setter) |
| Value channel | `current_json` + `current_value` + type-specific callbacks | `current_value: &dyn Any` + `write_back: Box<dyn Any + Send>` |
| Widget initialization | Separate `UiPropertyEditorInitHint` inventory path | Editor constructor (`cx.new`) — standard GPUI entity lifecycle |
| Framework knowledge | Knew about bool toggles, enum selects, JSON | Knows nothing — pure type-erased dispatch by `TypeId` |
| Enum editors | Manual `build_enum_type_info(...)` with TypeId hijack | Auto-registered via `#[derive(Reflectable)]` on any C-like enum |
| Primitive coverage | `f32` but not `f64` | Both registered |

The framework layer (`render_property_row_runtime` in `ui_common`) went from 158 lines with type-specific branching to 158 lines with none. The `PropertyEditorRegistry` went from a `HashMap<TypeId, PropertyEditorFactory>` with ad-hoc dispatch to a `HashMap<TypeId, PropertyEditorFactory>` with the same dispatch — the difference is that the dispatch no longer has special cases because the factory contract was reduced to its essentials.

The enum dropdown editor is the proof that the architecture works. It was added in a single commit without touching the framework layer. The factory registered itself, the runtime registry picked it up, and the properties panel started rendering dropdowns for every enum field in the engine — `LightType`, `IntensityUnits`, `MobileQualityLevel`, `ShadowCacheMode`, and any enum any plugin registers in the future. No per-type registration. No framework changes. No JSON path. Just a `UiPropertyEditorHint` pointing to a generic function.

That's the measure of type-agnostic design: adding a new category of editor doesn't require changing anything except the editor itself.
