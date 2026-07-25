// Siri-style orb — a real 3D shaded sphere rendered with a WebGL fragment
// shader: animated simplex-noise iridescence (indigo/blue/purple/pink),
// diffuse form shading, a glossy specular highlight, a Fresnel rim, and a soft
// bloom. Resolution-independent, dependency-free, works inside a shadow DOM.

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}';

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uActive;

vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){ float f=0.0,a=0.5; for(int i=0;i<5;i++){ f+=a*snoise(p); p=p*2.02; a*=0.5; } return f; }

const vec3 C_INDIGO=vec3(0.30,0.28,0.82);
const vec3 C_BLUE  =vec3(0.28,0.58,1.00);
const vec3 C_PURPLE=vec3(0.60,0.32,0.98);
const vec3 C_PINK  =vec3(1.00,0.44,0.86);
vec3 siri(float m, float w){
  float a=0.5+0.5*m, b=0.5+0.5*w;
  vec3 col=mix(C_INDIGO,C_BLUE,smoothstep(0.15,0.85,a));
  col=mix(col,C_PURPLE,smoothstep(0.25,0.9,b));
  col=mix(col,C_PINK,smoothstep(0.55,1.0,a*b));
  return col;
}

void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*uRes)/(0.5*uRes.y);
  float speed=1.0+0.9*uActive;
  float t=uTime*0.22*speed;
  float R=0.78;
  float r=length(uv);
  vec3 outc=vec3(0.0); float alpha=0.0;

  if(r<R+0.02){
    float z=sqrt(max(R*R-r*r,0.0));
    vec3 n=vec3(uv,z)/R;
    vec3 q=n*1.7;
    float w=fbm(q+vec3(0.0,0.0,t));
    float m=fbm(q*1.25+w*0.7+vec3(t*0.7,-t*0.45,t*0.25));
    vec3 col=siri(m,w);
    vec3 L=normalize(vec3(-0.35,0.55,0.75));
    float diff=clamp(dot(n,L),0.0,1.0);
    col*=0.6+0.5*diff;
    col+=0.06;
    vec3 V=vec3(0.0,0.0,1.0);
    vec3 H=normalize(L+V);
    float spec=pow(clamp(dot(n,H),0.0,1.0),42.0);
    col+=spec*vec3(1.0)*0.7;
    float fres=pow(1.0-n.z,2.6);
    col+=fres*vec3(0.55,0.72,1.0)*0.9;
    col*=1.0+0.12*uActive*sin(uTime*5.0);
    outc=col;
    alpha=smoothstep(R+0.01,R-0.03,r);
  }
  float halo=smoothstep(R+0.30,R-0.02,r);
  outc+=(1.0-alpha)*halo*halo*vec3(0.42,0.38,0.85)*0.55;
  alpha=max(alpha,halo*halo*0.5);

  gl_FragColor=vec4(clamp(outc,0.0,1.0),alpha);
}`;

/**
 * Render the orb into `canvas`, sizing it from its CSS box × devicePixelRatio.
 * `getActive` is polled each frame — return true to speed up / brighten the orb
 * (used while Tidra is thinking). Returns a cleanup function.
 */
export function mountOrb(canvas: HTMLCanvasElement, getActive: () => boolean): () => void {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: false,
    antialias: true,
  });
  if (!gl) return () => {};

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  const uRes = gl.getUniformLocation(prog, 'uRes');
  const uTime = gl.getUniformLocation(prog, 'uTime');
  const uActive = gl.getUniformLocation(prog, 'uActive');

  let raf = 0;
  let disposed = false;
  const t0 = performance.now();

  const sync = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  const frame = (now: number) => {
    if (disposed) return;
    sync();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uRes, canvas.width, canvas.height);
    gl.uniform1f(uTime, (now - t0) / 1000);
    gl.uniform1f(uActive, getActive() ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  };
}
