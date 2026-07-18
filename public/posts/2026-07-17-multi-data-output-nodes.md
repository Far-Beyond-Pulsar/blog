---
title: "Multi-Data-Output Nodes — One Binding, Many Pins"
date: "2026-07-17"
author: "Tristan Poland"
tags: ["graphy", "psgc", "pbgc", "pulsar", "shaders", "blueprint", "compiler", "wgsl", "rust"]
description: "How Pulsar's node graph compilers handle nodes that produce multiple values — the cross-language accessor pattern, compiler internals, and the #[output] / bp_return! macros."
thumbnail: /post_thumb/multi_output.png
---

Visual node graphs have an asymmetry. You can trivially make a node with ten input pins. Most graph systems only let you have one output.

Unreal Engine works around this with special Break/Make nodes that the editor handles as a single unit. Shader editors in games often just ignore the problem. Your options are pass a vec4 around, or make three separate component-extract nodes. Neither scales.

We wanted something better. Not a one-off workaround for break nodes. A general mechanism that works across all three backends. WGSL for shaders. Rust for blueprint function calls. The bytecode VM for runtime dispatch. No additional ABI complexity. No runtime overhead. No special cases in the editor.

---

## The Core Problem

A GPU function can only return one value. A Rust function can return a tuple, but the blueprint executor dispatches through a C ABI shim that writes to a single output slot. The shader editor's `vec3_split` node just passed the input through. Individual components were extracted by separate `vec3_x`, `vec3_y`, `vec3_z` nodes, each generating its own `let` binding.

This worked. It also meant that breaking a `vec4` into its four components required four node instances. One for the split. Three for the component extracts. The wire count grew quadratically with the number of components you needed. The graph became visually noisy with intermediate nodes that existed solely to rename fields.

The constraints were concrete. No multi-return in the target language. One `let` binding per node in the codegen. One output arena slot per node in the bytecode VM. Backward compatibility with thousands of existing single-output nodes.

---

## The Accessor Pattern

The solution is a structural decomposition at the metadata layer, not the codegen layer. We introduced `OutputParam`. A named output pin that carries an accessor string.

```rust
pub struct OutputParam {
    pub name: String,
    pub param_type: String,
    pub accessor: String,
}
```

Each node still emits exactly one `let` binding. The accessor gets appended at the consumer site.

```wgsl
let N = v;                              // break_vec4 emits one binding
let result = N.r + 1.0;                 // consumer appends ".r"
let result = M_result + 1.0;            // single-output: accessor is ""
```

The codegen never interprets the accessor. It is an opaque string. Could be `.r`. Could be `.0`. Could be `[0]`. Whatever the target language needs. The node author writes it as metadata.

```rust
NodeMetadata::new("break_vec4", NodeTypes::pure, "Vector")
    .with_params(vec![ParamInfo::new("v", "vec4<f32>")])
    .with_return_type("vec4<f32>")
    .with_source("v")
    .with_outputs(vec![
        OutputParam::new("r", "f32", ".r"),
        OutputParam::new("g", "f32", ".g"),
        OutputParam::new("b", "f32", ".b"),
        OutputParam::new("a", "f32", ".a"),
    ]);
```

`effective_outputs()` handles backward compat. When `output_params` is empty, it synthesises a single `"result"` pin with accessor `""`. Matches every existing node.

---

## How Each Compiler Treats It

The accessor pattern is the same concept in all three backends. Each interprets it differently based on its native ABI.

### WGSL

The shader codegen emits a single `let` binding. When a downstream node references an output pin, the codegen looks up the source node's `effective_outputs()`, finds the matching pin by name, and appends its accessor.

```rust
fn source_pin_accessor(&self, source_node_id: &str, source_pin: &str) -> String {
    let outputs = meta.effective_outputs();
    if outputs.len() <= 1 && source_pin == "result" {
        return String::new();
    }
    outputs.iter()
        .find(|o| o.name == source_pin)
        .map(|o| o.accessor.clone())
        .unwrap_or_default()
}
```

The fast path handles the common case. 200+ single-output nodes return the empty string immediately.

### Rust

For multi-output functions, the Rust function returns a tuple. The codegen emits a temporary for the tuple, then one destructuring `let` per output pin.

```rust
// Generated code:
let __div_mod_result = div_mod(a, b);
let quotient = __div_mod_result.0;
let remainder = __div_mod_result.1;
// Consumer reads "quotient":
let doubled = quotient * 2;
```

The accessor strings `.0` and `.1` come from the source node's `OutputParam`. Same mechanism as WGSL. Different accessor values.

### Bytecode VM

The bytecode codegen allocates a single arena slot large enough for the packed tuple. Field offsets within that slot are computed using Rust's layout rules. `Instruction::Call` carries the base offset. `resolve_input_offset` computes per-field accesses.

```rust
struct OutputSlot {
    base_offset: usize,
    field_offsets: HashMap<String, usize>,
}
```

The dispatch shim writes the packed tuple to the base slot unchanged.

```rust
unsafe extern "C" fn __bp_dispatch_div_mod(
    args: *const *const u8,
    ret: *mut u8,
    _type_slots: *const u8,
) {
    let __result = div_mod(read_arg::<i64>(args, 0), read_arg::<i64>(args, 1));
    ::std::ptr::write(ret as *mut (i64, i64), __result);
}
```

Consumers read from the same base slot plus the field offset. No tuple destructuring at the bytecode level.

The same dispatch ABI works for single and multi-output. For single-output functions, the tuple is a trivial one-element struct. `ret` points to a single value. For multi-output, it points to a larger packed tuple. The shim never needs to know which case it is.

---

## User-Facing Interfaces

We provide two ways to declare multi-output nodes, plus a macro sugar for tight inner loops.

### `#[output]` Attribute

```rust
#[blueprint(type: NodeTypes::pure, category: "Math")]
#[output(name = "quotient")]
#[output(name = "remainder")]
fn div_mod(a: i64, b: i64) -> (i64, i64) {
    (a / b, a % b)
}
```

The `#[output]` attrs map positionally to tuple elements. First attr gets accessor `.0`. Second gets `.1`. The proc macro validates that the number of attrs matches the return tuple arity at compile time. A mismatch is a hard error.

### `bp_return!` Macro

```rust
#[blueprint(type: NodeTypes::pure, category: "Math")]
fn div_mod(a: i64, b: i64) {
    bp_return!(quotient: a / b, remainder: a % b);
}
```

The proc macro scans the function body for `bp_return!` invocations, extracts the label names, generates `#[output]` attrs from them, and replaces the macro invocation with `return (expr1, expr2, ...)`. The expanded form is identical to the canonical version.

`bp_return!` is optional sugar. Everything works with just `#[output]` plus tuple return. The macro exists for functions where writing out the tuple return feels redundant.

### `#[conversion]` Attribute

Same infrastructure powers automatic type conversion nodes.

```rust
#[blueprint(type: NodeTypes::pure, category: "Conversion")]
#[conversion(from = "i64", to = "f64", lossless = true)]
fn i64_to_f64(value: i64) -> f64 { value as f64 }
```

The `#[conversion]` attr bakes a `ConversionMeta` struct into the node metadata. The `ConversionRegistry` in graphy scans for these and uses them to auto-insert conversion nodes when a user connects incompatible but convertible types. The shader editor and blueprint editor both use the same registry. A conversion node registered on the WGSL side is invisible to the blueprint editor, and vice versa. Each side loads its own metadata provider.

---

## Frontend Usage

Multi-output nodes appear in the palette like any other node. No special icons. No separate category. A `break_vec4` node shows four output pins labelled `r`, `g`, `b`, `a` and one input labelled `v`. A `div_mod` node shows two output pins labelled `quotient` and `remainder`.

Breaking and connecting happens through the normal drag-to-connect flow. You drag from `break_vec4.r` to a `metallic` pin. You drag from `break_vec4.g` to a `roughness` pin. The editor treats each output pin as an independent connection point. There is no special Break/Make editor mode.

The wire colour for each output pin matches the component type. `r` is f32. `g` is f32. The wires show the same type colour as any other f32 output pin. Hovering over a multi-output node highlights all its output pins simultaneously, so you can see the full decomposition at a glance.

Conversion nodes work the same way. Drag a `white_noise_2d` (f32) to `make_vec4`'s `x` pin. Connect `y`, `z`, `w` from other sources. Or drop a `white_noise_2d` onto a `vec4` input pin and let the auto-converter insert `f32_to_vec4` for you. The auto-converter places the conversion node at the midpoint between source and target, fully undoable through the normal undo stack.

The reroute node also benefits. Double-click any connection line to insert a reroute. The reroute starts as a wildcard type. The first typed connection propagates its type through the reroute chain. Multi-output pins connect through reroutes without issue. The data flow analysis unwraps reroutes transparently, so the compiler never sees them.

---

## Backward Compatibility

A node without `output_params` and without `#[output]` attrs produces exactly the same metadata as before. One `"result"` pin with accessor `""`.

```rust
pub output_params: &'static [OutputParamMeta],
```

Defaults to `&[]` in the `linkme` static registration. Every existing blueprint function continues to produce one output pin. No codegen change. No editor change. No migration.

---

## Why Not Structs

The alternative to the accessor pattern is to have the node return a struct and let the editor decompose it. Unreal's Break/Make nodes work this way.

Structs are language-specific. A Rust struct has named fields. A WGSL struct has `@location` attributes. A C ABI struct has layout rules that may not match either. The accessor string is a single opaque token that each backend interprets in its own way. The WGSL codegen sees `.r` and appends it directly. The Rust codegen sees `.0` and generates `__result.0`. The bytecode codegen sees `.0` and computes a struct field offset. No shared struct layout required.

Structs require the consumer to know the struct definition. A consumer of a break node needs to know the struct's field names and types at graph-compile time. With accessors, the consumer just uses the source node's `effective_outputs()`. The same metadata API used for every other pin resolution. No special struct registry. No cross-module type resolution. No compile-order dependencies.

---

## What It Feels Like

The whole system took about 600 lines across four crates. `OutputParam` in the metadata. Accessor appending in the codegen. `#[output]` in the macro. `bp_return!` for sugar.

The WGSL side was implemented first. `break_vec2`, `break_vec3`, `break_vec4`. Each one is a node that takes a vector and exposes its components as named output pins. The Rust/blueprint side followed with the macro support. The bytecode VM needed no ABI changes. The packed tuple slot makes multi-output a subset of the existing dispatch mechanism.

The nicest outcome is that multi-output nodes are indistinguishable from single-output nodes in every layer except the metadata. The editor draws the same pins. The codegen emits the same `let` bindings. The executor dispatches through the same `extern "C"` shim. `OutputParam` is just another field on `NodeMetadata` with a few backend-specific interpretations of the accessor string.
