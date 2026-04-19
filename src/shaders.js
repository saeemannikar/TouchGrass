// TouchGrass Clay Shaders
// Warm clay material with fake subsurface scattering + cavity shading

export const clayVertexShader = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vWorldPos;
  varying vec3 vViewPos;
  varying float vCavity;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vec4 viewPos  = viewMatrix * worldPos;

    vWorldPos = worldPos.xyz;
    vViewPos  = viewPos.xyz;
    vNormal   = normalize(normalMatrix * normal);

    // Cavity approximation: normals pointing inward get darker
    // We approximate by dot of normal with a "up" vector
    vCavity = clamp(dot(vNormal, vec3(0.0, 1.0, 0.0)), 0.0, 1.0);

    gl_Position = projectionMatrix * viewPos;
  }
`;

export const clayFragmentShader = /* glsl */`
  uniform vec3  uLightDir;
  uniform vec3  uLightDir2;
  uniform vec3  uClayColor;
  uniform vec3  uShadowColor;
  uniform float uRoughness;
  uniform float uSSS;         // fake subsurface strength

  varying vec3  vNormal;
  varying vec3  vWorldPos;
  varying vec3  vViewPos;
  varying float vCavity;

  void main() {
    vec3 N  = normalize(vNormal);
    vec3 L1 = normalize(uLightDir);
    vec3 L2 = normalize(uLightDir2);
    vec3 V  = normalize(-vViewPos);

    // Key light -- warm slightly orange
    float diff1 = max(dot(N, L1), 0.0);
    // Fill light -- cooler, from below
    float diff2 = max(dot(N, L2), 0.0) * 0.35;

    // Wrap lighting -- clay doesn't have hard shadows
    float wrap1 = (dot(N, L1) + 0.4) / 1.4;  // wrap factor
    wrap1 = clamp(wrap1, 0.0, 1.0);

    // Fake SSS: backlit areas glow warm
    float sss = pow(clamp(1.0 - dot(N, L1), 0.0, 1.0), 2.0) * uSSS;

    // Specular -- rough clay has very soft, wide specular
    vec3 H = normalize(L1 + V);
    float spec = pow(max(dot(N, H), 0.0), 8.0) * (1.0 - uRoughness) * 0.15;

    // Ambient occlusion approximated by cavity
    float ao = mix(0.55, 1.0, vCavity);

    // Rim light -- thin edge highlight from back
    float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * 0.12;

    // Combine
    vec3 ambient = uShadowColor * 0.4 * ao;
    vec3 diffuse = uClayColor * (wrap1 * 0.8 + diff2) * ao;
    vec3 sssColor = vec3(0.9, 0.5, 0.3) * sss;
    vec3 specColor = vec3(1.0, 0.92, 0.85) * spec;
    vec3 rimColor  = uClayColor * rim;

    vec3 color = ambient + diffuse + sssColor + specColor + rimColor;

    // Subtle gamma
    color = pow(color, vec3(0.9));

    gl_FragColor = vec4(color, 1.0);
  }
`;

// Grid / ground plane shader
export const gridFragmentShader = /* glsl */`
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform vec3 uLineColor;

  void main() {
    vec2 grid = abs(fract(vUv * 20.0 - 0.5) - 0.5) / fwidth(vUv * 20.0);
    float line = min(grid.x, grid.y);
    float alpha = 1.0 - min(line, 1.0);
    alpha *= 0.25;
    vec3 col = mix(uColor, uLineColor, alpha);
    gl_FragColor = vec4(col, 0.18 + alpha * 0.4);
  }
`;

export const gridVertexShader = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
