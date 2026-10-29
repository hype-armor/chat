//! QR codes for linking devices (ADR-0019): drawing the link code on the
//! new device and reading it from camera frames on the old one.

use qrcode::{EcLevel, QrCode};

/// Modules of a QR code: `size` × `size`, row-major, `true` for dark.
pub struct Matrix {
    pub size: usize,
    pub dark: Vec<bool>,
}

pub fn encode(text: &str) -> Option<Matrix> {
    let code = QrCode::with_error_correction_level(text, EcLevel::M).ok()?;
    let size = code.width();
    let dark = code
        .into_colors()
        .into_iter()
        .map(|c| c == qrcode::Color::Dark)
        .collect();
    Some(Matrix { size, dark })
}

/// Finds and decodes the first QR code in a greyscale image (one byte per
/// pixel, row-major).
pub fn decode(luma: &[u8], width: usize, height: usize) -> Option<String> {
    if width == 0 || height == 0 || luma.len() < width * height {
        return None;
    }
    let mut image =
        rqrr::PreparedImage::prepare_from_greyscale(width, height, |x, y| luma[y * width + x]);
    image
        .detect_grids()
        .into_iter()
        .find_map(|grid| grid.decode().ok().map(|(_, text)| text))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Renders a matrix as an image with a quiet zone, `scale` pixels per module.
    fn render(m: &Matrix, scale: usize) -> (Vec<u8>, usize) {
        let side = (m.size + 8) * scale;
        let mut pixels = vec![255u8; side * side];
        for y in 0..m.size {
            for x in 0..m.size {
                if m.dark[y * m.size + x] {
                    for dy in 0..scale {
                        for dx in 0..scale {
                            pixels[((y + 4) * scale + dy) * side + (x + 4) * scale + dx] = 0;
                        }
                    }
                }
            }
        }
        (pixels, side)
    }

    #[test]
    fn round_trip() {
        let text = "chat-link:v1:3q2-7wEVEjRWeJq8zt7wEQ";
        let m = encode(text).unwrap();
        assert_eq!(m.dark.len(), m.size * m.size);
        let (pixels, side) = render(&m, 4);
        assert_eq!(decode(&pixels, side, side).as_deref(), Some(text));
    }

    #[test]
    fn no_code_in_a_blank_image() {
        assert_eq!(decode(&[255; 100 * 100], 100, 100), None);
        assert_eq!(decode(&[], 0, 0), None);
    }
}
