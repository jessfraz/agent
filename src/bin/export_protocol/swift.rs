//! A deliberately small JSON Schema -> Codable generator for the native boundary.
//! Unsupported shapes fail generation rather than silently weakening the contract.
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};

fn camel(value: &str) -> String {
    let mut parts = value.split(['_', '-']);
    let mut output = parts.next().unwrap_or_default().to_owned();
    for part in parts {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            output.extend(first.to_uppercase());
            output.extend(chars);
        }
    }
    output
}
fn ident(value: &str) -> String {
    format!("`{}`", camel(value))
}
fn upper(value: &str) -> String {
    let value = camel(value);
    let mut chars = value.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    })
}
fn ty(schema: &Value) -> Result<String> {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return Ok(reference
            .rsplit('/')
            .next()
            .context("Missing reference name")?
            .into());
    }
    if let Some(types) = schema.get("type").and_then(Value::as_array) {
        let nonnull: Vec<_> = types
            .iter()
            .filter(|t| t.as_str() != Some("null"))
            .collect();
        if nonnull.len() == 1 && types.len() == 2 {
            let mut schema = schema.clone();
            schema["type"] = nonnull[0].clone();
            return Ok(ty(&schema)? + "?");
        }
    }
    if let Some(variants) = schema.get("anyOf").and_then(Value::as_array) {
        let nonnull: Vec<_> = variants
            .iter()
            .filter(|t| t.get("type").and_then(Value::as_str) != Some("null"))
            .collect();
        if nonnull.len() == 1 && variants.len() == 2 {
            return Ok(ty(nonnull[0])? + "?");
        }
    }
    Ok(match schema.get("type").and_then(Value::as_str) {
        Some("string") => "String".into(),
        Some("boolean") => "Bool".into(),
        Some("integer") => "Int".into(),
        Some("array") => format!(
            "[{}]",
            ty(schema.get("items").context("Missing array items")?)?
        ),
        _ => bail!("Unsupported native schema: {schema}"),
    })
}
fn fields(schema: &Value, tag: Option<&str>) -> Result<Vec<(String, String)>> {
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .context("Missing object properties")?;
    properties
        .iter()
        .filter(|(name, _)| Some(name.as_str()) != tag)
        .map(|(name, value)| Ok((name.clone(), ty(value)?)))
        .collect()
}
fn structure(name: &str, fields: &[(String, String)]) -> String {
    let mut out = format!("public struct {name}: Codable, Sendable, Equatable {{\n");
    for (name, ty) in fields {
        out += &format!("    public var {}: {ty}\n", ident(name));
    }
    out += &format!(
        "    public init({}) {{\n",
        fields
            .iter()
            .map(|(name, ty)| format!(
                "{}: {ty}{}",
                ident(name),
                if ty.ends_with('?') { " = nil" } else { "" }
            ))
            .collect::<Vec<_>>()
            .join(", ")
    );
    for (name, _) in fields {
        out += &format!("        self.{0} = {0}\n", ident(name));
    }
    out += "    }\n    enum CodingKeys: String, CodingKey {\n";
    for (name, _) in fields {
        out += &format!("        case {} = \"{name}\"\n", ident(name));
    }
    out += "    }\n}\n\n";
    out
}
fn definition(name: &str, schema: &Value) -> Result<String> {
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        let mut out = format!("public enum {name}: String, Codable, Sendable, Equatable {{\n");
        for value in values {
            let value = value.as_str().context("Non-string enum")?;
            out += &format!("    case {} = \"{value}\"\n", ident(value));
        }
        out += "}\n\n";
        return Ok(out);
    }
    if matches!(
        schema.get("type").and_then(Value::as_str),
        Some("string" | "integer" | "boolean" | "array")
    ) {
        return Ok(format!("public typealias {name} = {}\n\n", ty(schema)?));
    }
    let Some(variants) = schema.get("oneOf").and_then(Value::as_array) else {
        return Ok(structure(name, &fields(schema, None)?));
    };
    if variants
        .iter()
        .all(|variant| variant.get("type").and_then(Value::as_str) == Some("string"))
    {
        let values: Vec<_> = variants
            .iter()
            .flat_map(|variant| {
                variant
                    .get("enum")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_else(|| variant.get("const").cloned().into_iter().collect())
            })
            .collect();
        return definition(name, &serde_json::json!({ "enum": values }));
    }
    let mut cases = Vec::new();
    let mut out = String::new();
    let tags = variants
        .first()
        .and_then(|variant| variant.get("properties"))
        .and_then(Value::as_object)
        .context("Missing variant properties")?
        .keys()
        .filter(|name| {
            variants.iter().all(|variant| {
                variant
                    .get("properties")
                    .and_then(|properties| properties.get(*name))
                    .and_then(|property| property.get("const"))
                    .and_then(Value::as_str)
                    .is_some()
            })
        })
        .collect::<Vec<_>>();
    let [tag_name] = tags.as_slice() else {
        bail!("Expected one common string variant tag")
    };
    for variant in variants {
        let tag = variant
            .get("properties")
            .and_then(|properties| properties.get(*tag_name))
            .and_then(|property| property.get("const"))
            .and_then(Value::as_str)
            .context("Missing variant tag")?;
        let fields = fields(variant, Some(tag_name))?;
        let payload = name.to_owned() + &upper(tag);
        if !fields.is_empty() {
            out += &structure(&payload, &fields);
        }
        cases.push((tag.to_owned(), payload, !fields.is_empty()));
    }
    out += &format!("public enum {name}: Codable, Sendable, Equatable {{\n");
    for (tag, payload, associated) in &cases {
        out += &format!(
            "    case {}{}\n",
            ident(tag),
            if *associated {
                format!("({payload})")
            } else {
                String::new()
            }
        );
    }
    let tag_key = camel(tag_name);
    out += &format!(
        "    enum CodingKeys: String, CodingKey {{ case {tag_key}{} }}\n    public init(from decoder: any Decoder) throws {{\n        let tag = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .{tag_key})\n        switch tag {{\n",
        if tag_key == **tag_name {
            String::new()
        } else {
            format!(" = \"{tag_name}\"")
        }
    );
    for (tag, payload, associated) in &cases {
        out += &format!(
            "        case \"{tag}\": self = .{}{}\n",
            ident(tag),
            if *associated {
                format!("(try {payload}(from: decoder))")
            } else {
                String::new()
            }
        );
    }
    out += "        default: throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: \"Unsupported protocol event: \\(tag)\"))\n        }\n    }\n    public func encode(to encoder: any Encoder) throws {\n        var tag = encoder.container(keyedBy: CodingKeys.self)\n        switch self {\n";
    for (name, _, associated) in &cases {
        out += &format!(
            "        case .{}{}:\n",
            ident(name),
            if *associated { "(let value)" } else { "" }
        );
        out += &format!("            try tag.encode(\"{name}\", forKey: .{tag_key})\n");
        if *associated {
            out += "            try value.encode(to: encoder)\n";
        }
    }
    out += "        }\n    }\n}\n\n";
    Ok(out)
}
pub fn generate(schemas: &[Value]) -> Result<String> {
    let mut definitions = Map::new();
    for schema in schemas {
        if let Some(defs) = schema.get("$defs").and_then(Value::as_object) {
            for (name, value) in defs {
                definitions.insert(name.clone(), value.clone());
            }
        }
        definitions.insert(
            schema
                .get("title")
                .and_then(Value::as_str)
                .context("Missing schema title")?
                .into(),
            schema.clone(),
        );
    }
    let mut output =
        "// Generated by make bindings from Rust schemas. Do not edit.\nimport Foundation\n\n"
            .to_owned();
    for (name, schema) in definitions {
        output += &definition(&name, &schema).with_context(|| format!("Generating {name}"))?;
    }
    Ok(output)
}

/// Cover every branch of the contract without a second hand-maintained fixture.
/// Values are decoded and reserialized by Rust before Swift consumes them.
pub fn samples(schema: &Value, root: &Value) -> Result<Vec<Value>> {
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        return samples(
            root.pointer(reference.trim_start_matches('#'))
                .context("Unknown sample reference")?,
            root,
        );
    }
    if let Some(value) = schema.get("const") {
        return Ok(vec![value.clone()]);
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        return Ok(values.clone());
    }
    if let Some(variants) = schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
    {
        let mut output = Vec::new();
        for variant in variants {
            output.extend(samples(variant, root)?);
        }
        return Ok(output);
    }
    if let Some(types) = schema.get("type").and_then(Value::as_array) {
        let mut output = Vec::new();
        for kind in types {
            let mut branch = schema.clone();
            branch["type"] = kind.clone();
            output.extend(samples(&branch, root)?);
        }
        return Ok(output);
    }
    Ok(match schema.get("type").and_then(Value::as_str) {
        Some("null") => vec![Value::Null],
        Some("boolean") => vec![Value::Bool(false), Value::Bool(true)],
        Some("integer") => vec![Value::from(1)],
        Some("string") => vec![Value::from(
            if schema.get("format").and_then(Value::as_str) == Some("uuid") {
                "11111111-1111-4111-8111-111111111111"
            } else {
                "example"
            },
        )],
        Some("array") => samples(schema.get("items").context("Missing sample items")?, root)?
            .into_iter()
            .map(|item| Value::Array(vec![item]))
            .collect(),
        Some("object") => {
            let properties = schema
                .get("properties")
                .and_then(Value::as_object)
                .context("Missing sample properties")?;
            let mut base = Map::new();
            let mut alternatives = Vec::new();
            for (name, property) in properties {
                let values = samples(property, root)?;
                base.insert(
                    name.clone(),
                    values.first().context("No sample value")?.clone(),
                );
                alternatives.push((name, values));
            }
            let mut output = vec![Value::Object(base.clone())];
            for (name, values) in alternatives {
                for value in values.into_iter().skip(1) {
                    let mut item = base.clone();
                    item.insert(name.clone(), value);
                    output.push(Value::Object(item));
                }
            }
            output
        }
        _ => bail!("Unsupported sample shape: {schema}"),
    })
}
