// The GLSL for the NavAIgate N, the one 3D mascot Helper Desk keeps. Written for Helper Desk: one full-screen pass,
// a signed-distance scene ray-marched per pixel.
// Every animation term is a whole-number multiple of uPhase, so a loop of one period repeats exactly and
// the captured strips join up without a seam.
//
// Contract with the renderer: a mascot source defines `float map(vec3)` and
// `vec4 shade(vec3 ro, vec3 rd, vec2 uv)` (premultiplied colour); PRELUDE comes first and FOOTER last.

export const VERTEX = `#version 300 es
in vec2 aPos;
void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

const PRELUDE = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uPhase;
uniform float uEnergy;
uniform float uGlow;
uniform float uSat;
uniform float uSettle;
uniform float uMode;
uniform sampler2D uSdf;
uniform vec3 uTint;
uniform int uAA;
out vec4 outColor;

const float TAU = 6.28318530718;
const float PI = 3.14159265359;
const float CAM_D = 4.0;
const float CAM_F = 3.15;
const vec3 LD = vec3(-0.4472, 0.6261, 0.6396);

float map(vec3 p);
float gDmin = 1e3;

float h31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float h21(vec2 p){ vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vn(vec3 p){
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1.,0.,0.)), f.x), mix(h31(i + vec3(0.,1.,0.)), h31(i + vec3(1.,1.,0.)), f.x), f.y),
             mix(mix(h31(i + vec3(0.,0.,1.)), h31(i + vec3(1.,0.,1.)), f.x), mix(h31(i + vec3(0.,1.,1.)), h31(i + vec3(1.,1.,1.)), f.x), f.y), f.z);
}
float fbm(vec3 p){
  float a = 0.5; float s = 0.0;
  for (int i = 0; i < 4; i++){ s += a * vn(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
mat2 rot(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }
float smin(float a, float b, float k){ float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float sdCap(vec3 p, float h, float r){ p.y -= clamp(p.y, -h, h); return length(p) - r; }
float sdRoundBox(vec3 p, vec3 b, float r){ vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }
float sdRect2(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float pill2(vec2 p, vec2 c, float hh, float r){ p -= c; p.y -= clamp(p.y, -hh, hh); return length(p) - r; }
vec3 hueRot(vec3 c, float a){ float ca = cos(a); float sa = sin(a); vec3 k = vec3(0.57735); return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca); }
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
float bump(float x, float c, float w){ float d = abs(fract(x - c + 0.5) - 0.5); return 1.0 - smoothstep(0.0, w, d); }
float settleK(){ return (1.0 - uSettle) * cos(uSettle * TAU * 2.25); }

vec3 studio(vec3 r){
  float y = clamp(r.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.34, 0.36, 0.43), vec3(0.88, 0.92, 1.0), smoothstep(0.15, 0.85, y));
  c += vec3(1.5, 1.45, 1.4) * pow(max(dot(r, normalize(vec3(-0.55, 0.65, 0.55))), 0.0), 22.0);
  c += vec3(0.45, 0.55, 0.85) * pow(max(dot(r, normalize(vec3(0.8, 0.25, 0.2))), 0.0), 10.0);
  c += vec3(0.9) * pow(max(dot(r, normalize(vec3(0.1, 0.9, -0.4))), 0.0), 36.0);
  return c;
}

vec3 calcN(vec3 p){
  vec2 e = vec2(0.0012, 0.0);
  return normalize(vec3(map(p + e.xyy) - map(p - e.xyy), map(p + e.yxy) - map(p - e.yxy), map(p + e.yyx) - map(p - e.yyx)));
}
float calcAO(vec3 p, vec3 n){
  float o = 0.0; float s = 1.0;
  for (int i = 1; i <= 4; i++){ float h = 0.07 * float(i); o += (h - map(p + n * h)) * s; s *= 0.7; }
  return clamp(1.0 - 1.7 * o, 0.0, 1.0);
}
float march(vec3 ro, vec3 rd){
  float t = 0.0; gDmin = 1e3;
  for (int i = 0; i < 80; i++){
    float d = map(ro + rd * t);
    gDmin = min(gDmin, d);
    if (d < 0.0008) return t;
    t += d;
    if (t > 7.0) break;
  }
  return -1.0;
}
vec4 shade(vec3 ro, vec3 rd, vec2 uv);
`;

const FOOTER = `
vec4 finish(vec4 c){
  float l = luma(c.rgb);
  c.rgb = mix(vec3(l), c.rgb, uSat);
  return c;
}
void main(){
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 4; j++){
    if (j >= uAA) break;
    for (int i = 0; i < 4; i++){
      if (i >= uAA) break;
      vec2 o = (vec2(float(i), float(j)) + 0.5) / float(uAA) - 0.5;
      vec2 uv = ((gl_FragCoord.xy + o) * 2.0 - uRes) / uRes.y;
      vec3 ro = vec3(0.0, 0.0, CAM_D);
      vec3 rd = normalize(vec3(uv, -CAM_F));
      gDmin = 1e3;
      acc += finish(shade(ro, rd, uv));
    }
  }
  acc /= float(uAA * uAA);
  outColor = clamp(acc, 0.0, 1.0);
}
`;

const NAVN = `
// NavAIgate N: the ribbon-N extruded into a bevelled ink and graphite solid. The 2D shape is a distance field
// baked from the favicon's own path (navmark.ts) and read from uSdf as signed distance, its gradient and the
// distance travelled along the ribbon; the shader rounds the extrusion's edges and ray-marches it.
// uMode: 0 working, 1 idle, 2 waiting for you, 3 done, 4 error.
const float HALF = 1.2;
const float HT = 0.17;
const float BEV = 0.085;
const vec3 INK = vec3(0.022, 0.026, 0.039);
const vec3 GRAPHITE = vec3(0.30, 0.32, 0.37);
const vec3 LIVE_BLUE = vec3(0.1647, 0.3569, 1.0);
float ph = 0.0;
mat3 gR = mat3(1.0);

vec4 field(vec2 p){
  vec2 q = clamp(p, vec2(-HALF), vec2(HALF));
  vec4 f = texture(uSdf, q / (2.0 * HALF) + 0.5);
  f.x += length(p - q);
  return f;
}
float map(vec3 p){
  vec2 w = vec2(field(p.xy).x + BEV, abs(p.z) - HT + BEV);
  return length(max(w, 0.0)) + min(max(w.x, w.y), 0.0) - BEV;
}
vec3 solidNormal(vec3 p){
  vec4 f = field(p.xy);
  vec2 w = vec2(f.x + BEV, abs(p.z) - HT + BEV);
  vec2 g = length(f.yz) > 1e-3 ? normalize(f.yz) : vec2(0.0, 1.0);
  vec3 n = vec3(g * max(w.x, 0.0), sign(p.z) * max(w.y, 0.0));
  float l = length(n);
  if (l < 1e-5) return w.x > w.y ? vec3(g, 0.0) : vec3(0.0, 0.0, sign(p.z));
  return n / l;
}
float lobe(float t, float centre, float width){ return 0.5 + 0.5 * cos(PI * clamp(abs(t - centre) / width, 0.0, 1.0)); }
float travel(float x, float a, float b){ float s = smoothstep(a, b, x); return mix(-0.25, 1.25, s * s * (3.0 - 2.0 * s)); }
vec3 env(vec3 r, float lift){
  float y = r.y * 0.5 + 0.5;
  vec3 c = mix(vec3(0.03, 0.035, 0.05), vec3(0.34, 0.37, 0.45), smoothstep(0.1, 0.95, y));
  c += vec3(1.0, 1.02, 1.05) * (pow(max(dot(r, normalize(vec3(-0.5, 0.7, 0.5))), 0.0), 5.0) * 1.4 + pow(max(dot(r, normalize(vec3(-0.5, 0.7, 0.5))), 0.0), 44.0) * 2.6);
  c += vec3(0.62, 0.74, 1.0) * pow(max(dot(r, normalize(vec3(0.9, 0.05, 0.3))), 0.0), 16.0) * 1.1;
  c += vec3(0.5, 0.55, 0.65) * pow(max(dot(r, normalize(vec3(0.1, -0.85, 0.5))), 0.0), 3.0) * 0.28;
  return c * (1.0 + lift);
}
vec4 shade(vec3 ro, vec3 rd, vec2 uv){
  ph = uPhase * TAU;
  float mode = uMode;
  float yaw = 0.0;
  float pitch = 0.0;
  float rim = 0.0;
  float sweepAt = -1.0;
  float sweepAmp = 0.0;
  float sweepW = 0.12;
  if (mode < 0.5){
    yaw = 0.125 * sin(ph);
    pitch = 0.035 * sin(ph + 1.5708);
    rim = 0.64 + 0.28 * sin(ph - 1.5708);
    sweepAt = travel(uPhase, 0.06, 0.94);
    sweepAmp = 1.0;
  } else if (mode < 1.5){
    yaw = 0.05 * sin(ph);
    pitch = 0.018 * sin(ph + 1.5708);
    sweepAt = travel(uPhase, 0.42, 0.72);
    sweepAmp = 0.5;
    sweepW = 0.16;
  } else if (mode < 2.5){
    yaw = 0.035 * sin(ph);
    pitch = 0.015 * sin(ph + 1.5708);
    float pulse = 0.5 - 0.5 * cos(ph);
    rim = 0.06 + 0.94 * pulse * pulse * (3.0 - 2.0 * pulse);
  } else if (mode < 3.5){
    float e = smoothstep(0.0, 1.0, uSettle);
    yaw = 0.11 * (1.0 - e);
    pitch = -0.03 * (1.0 - e);
    sweepAt = mix(-0.25, 1.25, e);
    sweepAmp = 0.55;
    sweepW = 0.15;
  }
  yaw += -0.2;
  pitch += 0.1;
  float cy = cos(yaw); float sy = sin(yaw); float cp = cos(pitch); float sp = sin(pitch);
  gR = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy) * mat3(1.0, 0.0, 0.0, 0.0, cp, sp, 0.0, -sp, cp);
  mat3 gI = transpose(gR);
  vec3 o = gI * ro;
  vec3 d = gI * rd;
  float zr = HT + 0.01;
  float ta = (-zr - o.z) / d.z;
  float tb = (zr - o.z) / d.z;
  float t = max(min(ta, tb), 0.0);
  float t1 = max(ta, tb);
  bool hit = false;
  for (int i = 0; i < 56; i++){
    float h = map(o + d * t);
    if (h < 0.0007){ hit = true; break; }
    t += h * 0.92;
    if (t > t1) break;
  }
  float fade = smoothstep(1.0, 0.74, length(uv));
  if (!hit){
    float tz = -o.z / d.z;
    vec2 q = (o + d * tz).xy;
    float dist = max(field(q).x, 0.0);
    float shadow = (1.0 - smoothstep(-0.02, 0.2, field(q - vec2(-0.035, 0.07)).x)) * 0.13 * fade;
    float halo = exp(-dist * 9.0);
    vec3 hc = vec3(0.0);
    float ha = 0.0;
    if (mode < 0.5){ hc = LIVE_BLUE; ha = halo * (0.06 + 0.14 * rim); }
    else if (mode > 1.5 && mode < 2.5){ hc = LIVE_BLUE; ha = halo * 0.17 * rim; }
    else if (mode > 2.5 && mode < 3.5){ hc = vec3(0.72, 0.8, 1.0); ha = halo * 0.2 * uGlow; }
    ha *= fade;
    return vec4(hc * ha, ha + shadow * (1.0 - ha));
  }
  vec3 p = o + d * t;
  vec3 no = solidNormal(p);
  vec3 nw = gR * no;
  vec4 f = field(p.xy);
  float ndv = clamp(dot(nw, -rd), 0.0, 1.0);
  float wall = 1.0 - abs(no.z);
  float edge = smoothstep(0.12, 0.7, wall);
  float lit = clamp(dot(nw, normalize(vec3(-0.5, 0.7, 0.5))) * 0.5 + 0.5, 0.0, 1.0);
  vec3 base = mix(INK, GRAPHITE, edge * 0.85);
  base = mix(base, GRAPHITE * 0.55, (1.0 - edge) * 0.22 * smoothstep(0.1, 1.0, f.w));
  vec3 col = base * (0.45 + 0.85 * lit * lit);
  vec3 r = reflect(rd, nw);
  float band = sweepAt > -0.5 ? lobe(f.w, sweepAt, sweepW) * sweepAmp : 0.0;
  float fres = 0.07 + 0.93 * pow(1.0 - ndv, 5.0);
  col += env(r, band * 1.2) * mix(0.3, 0.5, edge) * mix(1.0, fres * 3.0 + 0.4, 0.4) * (mode > 3.5 ? 0.45 : 1.0);
  vec3 sheen = mode < 0.5 ? vec3(0.62, 0.74, 1.0) : vec3(0.88, 0.92, 1.0);
  col += sheen * band * (0.1 + 0.4 * edge + 0.2 * fres);
  float rimK = (0.4 * pow(1.0 - ndv, 2.2) + 0.36 * pow(max(dot(nw, normalize(vec3(0.75, -0.3, 0.4))), 0.0), 2.0)) * smoothstep(0.08, 0.5, wall);
  col += LIVE_BLUE * rimK * rim * 1.0;
  col += vec3(0.8, 0.88, 1.0) * edge * 0.05 * uGlow;
  col *= 1.0 + uGlow * 0.12;
  if (mode > 3.5) col *= 0.95;
  return vec4(col, 1.0);
}
`;

export const MASCOT_SOURCES: Record<string, string> = {
  navn: NAVN,
};

export function fragmentFor(id: string): string {
  const src = MASCOT_SOURCES[id];
  if (!src) throw new Error(`No shader for ${id}`);
  return PRELUDE + src + FOOTER;
}
