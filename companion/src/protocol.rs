use serde::Deserialize;
use serde_json::Value;
use std::io::{self, Read, Write};

// Three locally resized photos, plus bounded text and JSON overhead.
pub const MAX_INPUT: usize = 13 * 1024 * 1024;
pub const MAX_OUTPUT: usize = 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: String,
    pub command: String,
    #[serde(default)]
    pub payload: Value,
}

pub fn read_message(reader: &mut impl Read) -> io::Result<Option<Request>> {
    let mut header = [0u8; 4];
    if reader.read(&mut header[..1])? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..])?;
    let length = u32::from_ne_bytes(header) as usize;
    if length == 0 || length > MAX_INPUT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid message size",
        ));
    }
    let mut data = vec![0; length];
    reader.read_exact(&mut data)?;
    let request: Request = serde_json::from_slice(&data)?;
    if request.id.len() > 128 || request.command.len() > 32 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid request",
        ));
    }
    Ok(Some(request))
}

pub fn write_message(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_OUTPUT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Response too large",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    #[test]
    fn handles_consecutive_frames_without_reading_past_each() {
        let mut bytes = Vec::new();
        write_message(&mut bytes, &json!({"id":"a","command":"status"})).unwrap();
        write_message(&mut bytes, &json!({"id":"b","command":"models"})).unwrap();
        let mut cursor = Cursor::new(bytes);
        assert_eq!(read_message(&mut cursor).unwrap().unwrap().id, "a");
        assert_eq!(read_message(&mut cursor).unwrap().unwrap().id, "b");
        assert!(read_message(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn rejects_oversize_and_truncated_frames() {
        assert!(read_message(&mut Cursor::new(((MAX_INPUT + 1) as u32).to_ne_bytes())).is_err());
        assert!(read_message(&mut Cursor::new(vec![2, 0])).is_err());
        assert!(read_message(&mut Cursor::new(vec![2, 0, 0, 0, b'{'])).is_err());
    }
}
