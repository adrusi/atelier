//! Framing on the daemon's unix socket: a 4-byte little-endian length, then
//! that many bytes of UTF-8 JSON (one JSON-RPC message). Native messaging uses
//! the same shape with native byte order; see native_host.rs.

use serde_json::Value;
use std::io::{self, Read, Write};

/// Refuse absurd frames rather than allocating for them.
pub const MAX_FRAME: usize = 64 * 1024 * 1024;

pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::other(format!(
            "frame of {len} bytes is too large"
        )));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    serde_json::from_slice(&buf)
        .map(Some)
        .map_err(io::Error::other)
}

pub fn write_frame(w: &mut impl Write, msg: &Value) -> io::Result<()> {
    let buf = serde_json::to_vec(msg)?;
    w.write_all(&(buf.len() as u32).to_le_bytes())?;
    w.write_all(&buf)?;
    w.flush()
}

pub async fn read_frame_async(
    r: &mut (impl tokio::io::AsyncRead + Unpin),
) -> io::Result<Option<Value>> {
    use tokio::io::AsyncReadExt;
    let len = match r.read_u32_le().await {
        Ok(n) => n as usize,
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    };
    if len > MAX_FRAME {
        return Err(io::Error::other(format!(
            "frame of {len} bytes is too large"
        )));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf)
        .map(Some)
        .map_err(io::Error::other)
}

pub async fn write_frame_async(
    w: &mut (impl tokio::io::AsyncWrite + Unpin),
    msg: &Value,
) -> io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let buf = serde_json::to_vec(msg)?;
    w.write_u32_le(buf.len() as u32).await?;
    w.write_all(&buf).await?;
    w.flush().await
}

// JSON-RPC 2.0 helpers.

pub fn request(id: u64, method: &str, params: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub fn notification(method: &str, params: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub fn response(id: Value, result: Value) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

pub mod code {
    pub const INVALID_REQUEST: i64 = -32600;
    pub const METHOD_NOT_FOUND: i64 = -32601;
    pub const INVALID_PARAMS: i64 = -32602;
    pub const INTERNAL: i64 = -32603;
    /// atelier: the client must send `initialize` first, with a compatible version.
    pub const NOT_INITIALIZED: i64 = -32002;
}
