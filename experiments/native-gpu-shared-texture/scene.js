"use strict";

const canvas = document.getElementById("generated");
const gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
if (!gl) throw new Error("Source WebGL2 unavailable");

function compile(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(shader) || "source shader compile failed");
  return shader;
}
const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, `#version 300 es
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0,1);}`));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, `#version 300 es
precision highp float;uniform float u_t;uniform vec2 u_size;out vec4 outColor;
void main(){vec2 uv=gl_FragCoord.xy/max(u_size,vec2(1.));float a=.5+.5*sin(u_t*.9+uv.x*9.+uv.y*4.);float b=.5+.5*sin(-u_t*.55+uv.y*11.);vec3 c=mix(vec3(.05,.12,.42),vec3(.95,.28,.08),a);c=mix(c,vec3(1.,.68,.08),b*.45);outColor=vec4(c,1.);}`));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS))
  throw new Error(gl.getProgramInfoLog(program) || "source shader link failed");
gl.useProgram(program);
const timeLocation = gl.getUniformLocation(program, "u_t");
const sizeLocation = gl.getUniformLocation(program, "u_size");
const startedAt = performance.now();
function frame(now) {
  const width = Math.max(1, Math.round(innerWidth * devicePixelRatio));
  const height = Math.max(1, Math.round(innerHeight * devicePixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
  gl.uniform1f(timeLocation, (now - startedAt) / 1000);
  gl.uniform2f(sizeLocation, width, height);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  document.body.dataset.frame = String((Number(document.body.dataset.frame) || 0) + 1);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
