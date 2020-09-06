import * as twgl from 'twgl.js';

import simVert from '../gridded.vert';
import simFrag from './step.frag';
import drawVert from './draw.vert';
import drawFrag from './draw.frag';
import textureVert from '../gridded.vert';
import textureFrag from './texture.frag';

import { glDraw, griddedArrays } from '../webgl.js';
import {
  randomLongitudeArray,
  randomLatitudeArray,
  randomArray,
} from './random.js';

export default class ParticleSimulator {
  constructor(gl, options) {
    // public variables (no special actions needed in setters)
    this.rate = options.particles.rate;

    // private variables with corresponding public setters
    this._count = sqrtFloor(options.particles.count);
    this._lifetime = options.particles.lifetime;
    this._data = options.data;

    // private variables (no setters)
    this._gl = gl;
    this._gl.enable(gl.BLEND);
    this._gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this._gl.getExtension('OES_texture_float');
    this._gl.getExtension('OES_texture_float_linear');
    this._gl.getExtension('WEBGL_color_buffer_float');
    this._gl.getExtension('EXT_float_blend');

    this._programs = this._createPrograms();
    this._buffers = this._createBuffers();
    this._textures = this._createTextures();
    this._framebuffers = this._createFramebuffers();
  }

  set count(c) {
    this._count = sqrtFloor(c);

    this._gl.deleteBuffer(this._buffers.draw.indices);
    this._gl.deleteTexture(this._textures.simA);
    this._gl.deleteTexture(this._textures.simB);
    this._gl.deleteFramebuffer(this._framebuffers.simA.framebuffer);
    this._gl.deleteFramebuffer(this._framebuffers.simB.framebuffer);

    this._buffers.draw = this._createDrawBuffer();
    this._textures.simA = this._createSimATexture(),
    this._textures.simB = this._createSimBTexture(),
    this._framebuffers = this._createFramebuffers();
  }

  set lifetime(l) {
    this._lifetime = l;
    this._textures.simA = this._createSimATexture();
    this._framebuffers = this._createFramebuffers();
  }

  set data(d) {
    this._data = d;
    this._gl.deleteTexture(this._textures.vectorField);
    this._textures.vectorField = this._createVectorFieldTexture();
  }

  // using data in this._textures.simA, simulate and render to
  // this._framebuffers.simB (with this._textures.simB attached) the new
  // particle positions after timeDelta ms have passed
  step(timeDelta) {
    // switch rendering destination to our framebuffer
    twgl.bindFramebufferInfo(this._gl, this._framebuffers.simB);

    this._gl.disable(this._gl.BLEND);
    glDraw(this._gl, this._programs.sim, this._buffers.sim, {
      u_particleData: this._textures.simA,
      u_vectorField: this._textures.vectorField,
      u_random: this._textures.random,
      u_particleLifetime: this._lifetime,
      u_randLonLatOffsets: [Math.random(), Math.random()],
      u_gridWidth: this._data.width,
      u_gridHeight: this._data.height,
      u_timeDelta: timeDelta,
      u_rate: this.rate,
    });
    this._gl.enable(this._gl.BLEND);

    // switch rendering destination back to canvas
    twgl.bindFramebufferInfo(this._gl, null);

    // swap texture and frambuffer references for next render
    [this._textures.simA, this._textures.simB] =
      [this._textures.simB, this._textures.simA];
    [this._framebuffers.simA, this._framebuffers.simB] =
      [this._framebuffers.simB, this._framebuffers.simA];
  }

  // render the particles to the screen, where sharedUnfiorms determines the
  // projection, zoom, and lonLat centering
  draw(sharedUniforms, opacity) {
    glDraw(this._gl, this._programs.draw, this._buffers.draw, {
      u_particlePositions: this._textures.simA,
      u_particleCountSqrt: Math.sqrt(this._count),
      u_color: [1, 1, 1, opacity],
      u_pixelRatio: window.devicePixelRatio,
      ...sharedUniforms,
    }, this._gl.POINTS);
  }

  // render particles with trails to the screen
  drawWithTrails(sharedUniforms, opacity) {
    // first, draw previous background (slightly faded) to empty texture
    twgl.bindFramebufferInfo(this._gl, this._framebuffers.particleTrailsB);

    this._gl.disable(this._gl.BLEND);
    glDraw(this._gl, this._programs.texture, this._buffers.texture, {
      u_texture: this._textures.particleTrailsA,
      u_fade: 0.96,
    });
    this._gl.enable(this._gl.BLEND);

    // then, draw new particle positions on top of that
    glDraw(this._gl, this._programs.draw, this._buffers.draw, {
      u_particlePositions: this._textures.simA,
      u_particleCountSqrt: Math.sqrt(this._count),
      u_color: [1, 1, 1, opacity],
      u_pixelRatio: window.devicePixelRatio,
      ...sharedUniforms,
    }, this._gl.POINTS);

    // finally, draw texture to screen
    twgl.bindFramebufferInfo(this._gl, null);

    glDraw(this._gl, this._programs.texture, this._buffers.texture, {
      u_texture: this._textures.particleTrailsB,
      u_fade: 1,
    });

    // swap textures and framebuffers for next call
    [this._textures.particleTrailsA, this._textures.particleTrailsB] =
      [this._textures.particleTrailsB, this._textures.particleTrailsA];
    [this._framebuffers.particleTrailsA, this._framebuffers.particleTrailsB] =
      [this._framebuffers.particleTrailsB, this._framebuffers.particleTrailsA];
  }

  // start drawing trails from scratch again (when map is moved or zoomed)
  resetTrails() {
    twgl.resizeFramebufferInfo(this._gl, this._framebuffers.particleTrailsA, [{
      attachment: this._textures.particleTrailsA,
    }]);
    twgl.resizeFramebufferInfo(this._gl, this._framebuffers.particleTrailsB, [{
      attachment: this._textures.particleTrailsB,
    }]);

    twgl.bindFramebufferInfo(this._gl, this._framebuffers.particleTrailsA);
    this._gl.clear(this._gl.COLOR_BUFFER_BIT);
    twgl.bindFramebufferInfo(this._gl, null);
  }

  _createPrograms() {
    return {
      sim: twgl.createProgramInfo(this._gl, [simVert, simFrag]),
      draw: twgl.createProgramInfo(this._gl, [drawVert, drawFrag]),
      texture: twgl.createProgramInfo(this._gl, [textureVert, textureFrag]),
    };
  }

  _createBuffers() {
    let quadBuffer = twgl.createBufferInfoFromArrays(this._gl, griddedArrays);
    return {
      sim: quadBuffer,
      draw: this._createDrawBuffer(),
      texture: quadBuffer,
    };
  }

  _createDrawBuffer() {
    let indices = new Float32Array(2 * this._count);

    for (let i = 0; i < indices.length; i++) {
      let j = Math.floor(i / 2);
      if (i % 2 === 0) {
        indices[i] = Math.floor(j / Math.sqrt(this._count));
      } else {
        indices[i] = j % Math.sqrt(this._count);
      }
    }

    return twgl.createBufferInfoFromArrays(this._gl, {
      a_particleIndex: {
        numComponents: 2, // indicate we are using 2-dimensional points
        data: indices,
      },
    });
  }

  _createTextures() {
    const randomTextureSize = 2048;

    return {
      random: twgl.createTexture(this._gl, {
        src: randomArray(1, Math.pow(randomTextureSize, 2)),
        type: this._gl.FLOAT,
        format: this._gl.ALPHA,
        minMag: this._gl.NEAREST,
        width: randomTextureSize,
        height: randomTextureSize,
      }),
      simA: this._createSimATexture(),
      simB: this._createSimBTexture(),
      vectorField: this._createVectorFieldTexture(),
      particleTrailsA: this._createParticleTrailsTexture(),
      particleTrailsB: this._createParticleTrailsTexture(),
    };
  }

  _createSimATexture() {
    return twgl.createTexture(this._gl, {
      type: this._gl.FLOAT,
      minMag: this._gl.NEAREST,
      width: Math.sqrt(this._count),
      height: Math.sqrt(this._count),
      src: interleave4(
        randomLongitudeArray(this._count),
        randomLatitudeArray(this._count),
        randomArray(this._lifetime, this._count),
      ),
    });
  }

  _createSimBTexture() {
    return twgl.createTexture(this._gl, {
      type: this._gl.FLOAT,
      minMag: this._gl.NEAREST,
      width: Math.sqrt(this._count),
      height: Math.sqrt(this._count),
    });
  }

  _createVectorFieldTexture() {
    return twgl.createTexture(this._gl, {
      src: interleave4(this._data.uVelocities, this._data.vVelocities),
      type: this._gl.FLOAT,
      minMag: this._gl.LINEAR, // requires OES_texture_float_linear
      width: this._data.width,
      height: this._data.height,
    });
  }

  _createParticleTrailsTexture() {
    return twgl.createTexture(this._gl, {
      minMag: this._gl.NEAREST,
      width: this._gl.canvas.width * window.devicePixelRatio,
      height: this._gl.canvas.height * window.devicePixelRatio,
    });
  }

  _createFramebuffers() {
    return {
      ...this._createSimFramebuffers(),
      particleTrailsA: this._createParticleTrailsFramebuffer(
        this._textures.particleTrailsA,
      ),
      particleTrailsB: this._createParticleTrailsFramebuffer(
        this._textures.particleTrailsB,
      ),
    };
  }

  _createSimFramebuffers() {
    return {
      simA: twgl.createFramebufferInfo(
        this._gl,
        [{ attachment: this._textures.simA }],
        Math.sqrt(this._count),
        Math.sqrt(this._count),
      ),
      simB: twgl.createFramebufferInfo(
        this._gl,
        [{ attachment: this._textures.simB }],
        Math.sqrt(this._count),
        Math.sqrt(this._count),
      ),
    };
  }

  _createParticleTrailsFramebuffer(texture) {
    return twgl.createFramebufferInfo(
      this._gl,
      [{ attachment: texture }],
      this._gl.canvas.width * window.devicePixelRatio,
      this._gl.canvas.height * window.devicePixelRatio,
    );
  }
}

function sqrtFloor(x) {
  return Math.pow(Math.floor(Math.sqrt(x)), 2);
}

function interleave4(arrayR, arrayG, arrayB, arrayA) {
  let interleaved = new Float32Array(4 * arrayR.length);

  for (let i = 0; i < interleaved.length; i++) {
    if (i % 4 === 0) {
      interleaved[i] = arrayR[i/4];
    } else if (i % 4 === 1) {
      interleaved[i] = arrayG[Math.floor(i/4)];
    } else if (i % 4 === 2 && arrayB) {
      interleaved[i] = arrayB[Math.floor(i/4)];
    } else if (arrayA) {
      interleaved[i] = arrayA[Math.floor(i/4)];
    }
  }

  return interleaved;
}
