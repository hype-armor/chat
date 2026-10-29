// Compiles the .proto files with protox (pure Rust), so no `protoc` binary
// is needed on developer machines or in CI.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = "../../proto";
    let files = ["chat/v1/envelope.proto", "chat/v1/content.proto"];
    for file in files {
        println!("cargo:rerun-if-changed={proto_root}/{file}");
    }
    let fds = protox::compile(files, [proto_root])?;
    prost_build::Config::new().compile_fds(fds)?;
    Ok(())
}
