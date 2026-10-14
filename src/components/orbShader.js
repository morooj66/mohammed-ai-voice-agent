// GLSL for the audio-reactive orb. Original design (no third-party assets).
// Uniforms (all smoothed on the CPU side, see Orb.jsx):
//   uLevel  : current audio level 0..1 (mic level while listening, agent output while speaking)
//   uBass   : low-frequency energy 0..1   uHigh: high-frequency energy 0..1
//   uListen / uThink / uSpeak / uIdle : state weights 0..1 (cross-faded, sum ~1)

export const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

export const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uTime;
uniform float uLevel;
uniform float uBass;
uniform float uHigh;
uniform float uIdle;
uniform float uListen;
uniform float uThink;
uniform float uSpeak;
uniform float uMuted;
uniform vec3  uDeep;   // palette (defaults = Mohammed's original blue, see Orb.jsx PALETTES)
uniform vec3  uBlue;
uniform vec3  uTurq;

// --- value noise / fbm -------------------------------------------------------
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0; float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x, uRes.y);
  float r = length(p);
  float ang = atan(p.y, p.x);
  float t = uTime;

  // Palette: deep navy -> electric blue -> turquoise
  vec3 navy  = vec3(0.020, 0.043, 0.122);
  vec3 deep  = uDeep;   // Mohammed: (0.035, 0.110, 0.360)
  vec3 blue  = uBlue;   // Mohammed: (0.160, 0.420, 1.000)
  vec3 turq  = uTurq;   // Mohammed: (0.180, 0.900, 0.840)
  vec3 white = vec3(0.880, 0.970, 1.000);

  float active = uListen + uSpeak;

  // --- silhouette: breathing radius + audio-driven wobble ---------------------
  float breathe = 0.012 * sin(t * 0.7) * (uIdle + 0.5 * uThink);
  float R = 0.30 + breathe + 0.045 * uLevel * uSpeak + 0.025 * uLevel * uListen;
  float wob = 0.0;
  wob += (0.004 + 0.016 * uLevel * active) * sin(ang * 3.0 + t * 1.7);
  wob += (0.003 + 0.010 * uBass  * uSpeak) * sin(ang * 5.0 - t * 2.3);
  wob += (0.000 + 0.006 * uHigh  * uSpeak) * sin(ang * 8.0 + t * 3.6);
  wob += 0.008 * uListen * uLevel * (noise(vec2(ang * 2.0, t * 1.5)) - 0.5);
  float edge = R + wob;

  float inside = smoothstep(edge + 0.004, edge - 0.004, r);
  float rn = clamp(r / edge, 0.0, 1.0);
  float z = sqrt(max(0.0, 1.0 - rn * rn));          // pseudo-3D sphere depth

  // --- interior: flowing, domain-warped light ---------------------------------
  vec2 q = p / edge;
  // Rigid slow rotation (no accumulating twist) + a BOUNDED differential swirl while thinking.
  float swirl = t * 0.12 + uThink * (0.55 * sin(t * 1.1) + 0.35 * sin(t * 0.6 + 1.0)) * (1.0 - 0.5 * rn);
  q = rot(swirl) * q;
  q /= (0.55 + 0.45 * z);                           // fake refraction toward the rim
  float flow = t * (0.10 + 0.25 * uSpeak + 0.15 * uListen + 0.10 * uThink);
  vec2 w = vec2(fbm(q * 1.8 + flow), fbm(q * 1.8 - flow + 3.1));
  float n = fbm(q * 2.4 + 2.2 * w + vec2(0.0, flow));
  n = clamp(n + 0.25 * uLevel * active, 0.0, 1.0);

  vec3 col = mix(navy, deep, smoothstep(0.15, 0.55, n));
  col = mix(col, blue, smoothstep(0.45, 0.75, n) * (0.55 + 0.45 * z));
  col = mix(col, turq, smoothstep(0.62, 0.90, n) * (0.45 + 0.55 * (uSpeak * 0.6 + uListen * 0.4 + 0.35)));
  col += blue * 0.10 * z;                             // gentle inner luminance

  // speaking: soft horizontal energy bands driven by highs
  float bands = 0.5 + 0.5 * sin(q.y * 14.0 - t * 6.0 + n * 6.0);
  col += turq * 0.18 * uSpeak * uHigh * bands * z;

  // lighting: rim (fresnel) + specular highlight
  float fres = pow(1.0 - z, 2.4);
  col += mix(blue, turq, 0.5 + 0.5 * sin(ang + t * 0.5)) * fres * (0.55 + 0.6 * uLevel * active);
  vec2 hl = p - vec2(-0.10, 0.12) * edge / 0.30;
  col += white * 0.34 * smoothstep(0.17, 0.0, length(hl)) * z;
  col *= 0.75 + 0.35 * z;
  col *= mix(1.0, 0.55, uMuted * uListen);          // dim slightly when muted & listening

  // --- outside: glow, listening ripples, thinking ring ------------------------
  float d = max(r - edge, 0.0);
  float glow = exp(-d * (14.0 - 6.0 * uLevel * active)) * (0.22 + 0.45 * uLevel * active + 0.12 * uThink);
  vec3 outside = mix(blue, turq, 0.5 + 0.5 * sin(ang * 2.0 - t)) * glow;

  // listening: concentric ripples expanding outward
  float ripple = 0.0;
  for (int k = 0; k < 3; k++) {
    float ph = fract(t * 0.35 + float(k) / 3.0);
    float rr = edge + 0.02 + ph * 0.22;
    ripple += smoothstep(0.006, 0.0, abs(r - rr)) * (1.0 - ph) * (0.25 + 0.75 * uLevel);
  }
  outside += turq * ripple * uListen * 0.55;

  // thinking: orbiting comet arc
  float ringR = edge + 0.055;
  float ring = smoothstep(0.005, 0.0, abs(r - ringR));
  float head = fract((ang / 6.28318) - t * 0.45);
  outside += mix(blue, turq, head) * ring * pow(head, 3.0) * uThink * 1.4;

  vec3 color = col * inside + outside * (1.0 - inside);
  float alpha = clamp(inside + length(outside) * 1.2, 0.0, 1.0);
  gl_FragColor = vec4(color, alpha);
}
`;
