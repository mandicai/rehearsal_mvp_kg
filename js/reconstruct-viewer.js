// Inline three.js viewer for the 3D-reconstruction entry point (index.html's
// #reconstruct-module). openReconstructViewer(profile, hostEl) builds a small
// WebGL scene INSIDE hostEl per profile.viewer_mode and returns a teardown()
// that disposes everything (geometry/material/texture/renderer + RAF + events)
// so expanding/collapsing cards never leaks a WebGL context.
//
//   viewer_mode 'depth-displace' : color plane displaced in +Z by a depth map,
//                                  orbit within a clamped near-view cone.
//   viewer_mode 'flat'           : color plane, mild orbit (depth unavailable).
//   viewer_mode 'pano'           : equirectangular sphere, drag to pan/tilt.
//
// three.js is loaded globally (see index.html); a blocked CDN is handled by the
// typeof THREE guard, which shows a message instead of throwing.

function openReconstructViewer(profile, hostEl) {
  hostEl.innerHTML = '';

  // SHARP Gaussian splats render through GaussianSplats3D (its own module-three
  // instance), loaded on demand - handled entirely separately from the global
  // THREE depth/pano viewers below.
  if (profile.viewer_mode === 'splat') {
    return openSplatViewer(profile, hostEl);
  }

  if (typeof THREE === 'undefined') {
    const msg = document.createElement('div');
    msg.className = 'reconstruct-viewer-msg';
    msg.textContent = '3D viewer unavailable (three.js could not load).';
    hostEl.appendChild(msg);
    return function teardown() { hostEl.innerHTML = ''; };
  }

  const width = () => Math.max(1, hostEl.clientWidth || 480);
  const height = () => Math.round(width() * 9 / 16);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width(), height());
  if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
  hostEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e10);
  const camera = new THREE.PerspectiveCamera(55, width() / height(), 0.01, 2000);

  const loader = new THREE.TextureLoader();
  const disposables = [];
  const cleanups = [];
  let controls = null;
  let rafId = null;

  const aspect = (profile.width && profile.height) ? (profile.width / profile.height) : (16 / 9);

  function buildPlane(withDepth) {
    const planeH = 1.0;
    const planeW = planeH * aspect;
    const segX = withDepth ? 220 : 2;
    const segY = withDepth ? Math.max(2, Math.round(220 / aspect)) : 2;
    const geo = new THREE.PlaneGeometry(planeW, planeH, segX, segY);
    disposables.push(geo);

    const colorTex = loader.load(profile.color_url);
    if ('encoding' in colorTex) colorTex.encoding = THREE.sRGBEncoding;
    disposables.push(colorTex);

    let material;
    if (withDepth && profile.depth_url) {
      const depthTex = loader.load(profile.depth_url);
      disposables.push(depthTex);
      material = new THREE.ShaderMaterial({
        uniforms: {
          colorMap: { value: colorTex },
          depthMap: { value: depthTex },
          depthScale: { value: 0.35 },
        },
        vertexShader: `
          uniform sampler2D depthMap;
          uniform float depthScale;
          varying vec2 vUv;
          void main() {
            vUv = uv;
            float d = texture2D(depthMap, uv).r;   // near = bright
            vec3 p = position + vec3(0.0, 0.0, d * depthScale);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: `
          uniform sampler2D colorMap;
          varying vec2 vUv;
          void main() { gl_FragColor = texture2D(colorMap, vUv); }`,
      });
    } else {
      material = new THREE.MeshBasicMaterial({ map: colorTex });
    }
    disposables.push(material);
    const mesh = new THREE.Mesh(geo, material);
    scene.add(mesh);

    camera.position.set(0, 0, 1.15);
    if (THREE.OrbitControls) {
      controls = new THREE.OrbitControls(camera, renderer.domElement);
      controls.enablePan = false;
      controls.enableZoom = true;
      controls.minDistance = 0.7;
      controls.maxDistance = 1.8;
      // Keep the viewer inside the plausible near-view cone (2.5D breaks down
      // at steep angles / big camera moves).
      controls.minAzimuthAngle = -0.6;
      controls.maxAzimuthAngle = 0.6;
      controls.minPolarAngle = Math.PI / 2 - 0.5;
      controls.maxPolarAngle = Math.PI / 2 + 0.5;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
    }

    if (withDepth && profile.depth_url) buildDepthSlider(material);
  }

  function buildDepthSlider(material) {
    const wrap = document.createElement('div');
    wrap.className = 'reconstruct-depth-slider';
    const label = document.createElement('span');
    label.textContent = 'Depth';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '0.8';
    slider.step = '0.01';
    slider.value = String(material.uniforms.depthScale.value);
    const onInput = () => { material.uniforms.depthScale.value = parseFloat(slider.value); };
    slider.addEventListener('input', onInput);
    cleanups.push(() => slider.removeEventListener('input', onInput));
    wrap.appendChild(label);
    wrap.appendChild(slider);
    hostEl.appendChild(wrap);
  }

  // Equirectangular pano: camera at the sphere center, manual drag look (lon/lat)
  // - OrbitControls is degenerate with the camera at its target, so this mode
  // uses lightweight pointer handlers instead.
  function buildPano() {
    const geo = new THREE.SphereGeometry(500, 60, 40);
    geo.scale(-1, 1, 1); // view from the inside
    disposables.push(geo);
    const tex = loader.load(profile.color_url);
    if ('encoding' in tex) tex.encoding = THREE.sRGBEncoding;
    disposables.push(tex);
    const material = new THREE.MeshBasicMaterial({ map: tex });
    disposables.push(material);
    scene.add(new THREE.Mesh(geo, material));
    camera.position.set(0, 0, 0);

    let lon = 0, lat = 0, dragging = false, px = 0, py = 0;
    const el = renderer.domElement;
    const down = e => { dragging = true; px = e.clientX; py = e.clientY; };
    const move = e => {
      if (!dragging) return;
      lon -= (e.clientX - px) * 0.15;
      lat += (e.clientY - py) * 0.15;
      lat = Math.max(-80, Math.min(80, lat));
      px = e.clientX; py = e.clientY;
    };
    const up = () => { dragging = false; };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    cleanups.push(() => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    });

    controls = {
      update() {
        const phi = THREE.MathUtils.degToRad(90 - lat);
        const theta = THREE.MathUtils.degToRad(lon);
        camera.lookAt(
          500 * Math.sin(phi) * Math.cos(theta),
          500 * Math.cos(phi),
          500 * Math.sin(phi) * Math.sin(theta)
        );
      },
    };
  }

  if (profile.viewer_mode === 'pano') buildPano();
  else if (profile.viewer_mode === 'depth-displace') buildPlane(true);
  else buildPlane(false);

  function onResize() {
    renderer.setSize(width(), height());
    camera.aspect = width() / height();
    camera.updateProjectionMatrix();
  }
  let ro = null;
  if (window.ResizeObserver) {
    ro = new ResizeObserver(onResize);
    ro.observe(hostEl);
  } else {
    window.addEventListener('resize', onResize);
    cleanups.push(() => window.removeEventListener('resize', onResize));
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    if (controls && controls.update) controls.update();
    renderer.render(scene, camera);
  }
  animate();

  return function teardown() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    if (ro) ro.disconnect();
    cleanups.forEach(fn => { try { fn(); } catch (e) {} });
    if (controls && controls.dispose) controls.dispose();
    disposables.forEach(d => { try { d.dispose(); } catch (e) {} });
    renderer.dispose();
    if (renderer.forceContextLoss) { try { renderer.forceContextLoss(); } catch (e) {} }
    hostEl.innerHTML = '';
  };
}

// SHARP 3D Gaussian Splat viewer via GaussianSplats3D (mkkellogg), dynamically
// imported (ES module, its own three) so it only loads when a splat is opened.
// SHARP uses OpenCV coords (x right, y down, z forward) with the scene roughly
// in front along +z, so cameraUp is y-down and the camera sits behind the
// origin looking toward +z. Returns a teardown that disposes the viewer even if
// it's still loading (cancelled flag).
function openSplatViewer(profile, hostEl) {
  hostEl.innerHTML = '';
  hostEl.style.height = Math.max(320, Math.round((hostEl.clientWidth || 480) * 9 / 16)) + 'px';

  const status = document.createElement('div');
  status.className = 'reconstruct-viewer-msg';
  status.textContent = 'Loading 3D splats …';
  hostEl.appendChild(status);
  const say = t => { status.textContent = t; };
  const fail = (label, err) => {
    console.error('[splat] ' + label, err);
    hostEl.innerHTML = '';
    hostEl.appendChild(status);
    say('3D splat viewer error (' + label + '): ' + ((err && err.message) || err) +
        ' — see console.');
  };

  let viewer = null;
  let cancelled = false;

  // Frame on the ACTUAL scene center (computed backend-side from the .ply): the
  // look-at is also OrbitControls' pivot, so orbiting reveals parallax around
  // the content instead of swinging the whole cloud like a billboard.
  const lookAt = profile.scene_center || [0, 0, 1.48];
  const camPos = profile.camera_position || [0, 0, 0.0];
  console.log('[splat] url=%s center=%o camera=%o radius=%o',
    profile.gaussians_url, lookAt, camPos, profile.scene_radius);

  import('@mkkellogg/gaussian-splats-3d')
    .then(GS => {
      if (cancelled) return;
      if (!GS || !GS.Viewer) throw new Error('GaussianSplats3D module has no Viewer export');
      console.log('[splat] module loaded, constructing viewer');
      hostEl.innerHTML = '';
      try {
        viewer = new GS.Viewer({
          rootElement: hostEl,
          sharedMemoryForWorkers: false, // serve.py sets no COOP/COEP headers
          useBuiltInControls: true,
          gpuAcceleratedSort: true,
          cameraUp: [0, -1, 0],          // SHARP uses OpenCV y-down
          initialCameraPosition: camPos,
          initialCameraLookAt: lookAt,
        });
      } catch (e) { fail('viewer-construct', e); return; }
      return viewer.addSplatScene(profile.gaussians_url, {
        format: GS.SceneFormat.Ply,
        showLoadingUI: true,
        splatAlphaRemovalThreshold: 1,
        progressiveLoad: false,
        onProgress: (pct, msg, stage) => console.log('[splat] load', pct, msg, stage),
      }).then(() => {
        if (cancelled) { try { viewer.dispose(); } catch (e) {} return; }
        let n = '?';
        try { n = viewer.getSplatMesh && viewer.getSplatMesh().getSplatCount(); } catch (e) {}
        console.log('[splat] scene added, splat count =', n, '- starting render loop');
        viewer.start();
      }).catch(e => fail('addSplatScene', e));
    })
    .catch(err => { if (!cancelled) fail('import', err); });

  return function teardown() {
    cancelled = true;
    if (viewer) {
      try { viewer.stop && viewer.stop(); } catch (e) {}
      try { viewer.dispose && viewer.dispose(); } catch (e) {}
      viewer = null;
    }
    hostEl.style.height = '';
    hostEl.innerHTML = '';
  };
}
