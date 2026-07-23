import * as THREE from 'three'
import { parseDds, type DdsImage } from '../formats/dds'
import { bgraToRgba, decodeDxt } from '../formats/dxt'

export interface DdsTextureOptions {
  /**
   * Vertikal spiegeln (erzwingt CPU-Dekodierung bei DXT). Nötig für die in
   * SCMAP eingebetteten Masken/Watermaps, deren Zeilen gegenläufig zur
   * Heightmap gespeichert sind. Unit-Texturen: false (DirectX-UVs).
   */
  flipY?: boolean
}

/**
 * Erzeugt aus DDS-Rohdaten eine Three.js-Textur. Wenn die GPU S3TC
 * unterstützt (alle Desktop-GPUs), werden die DXT-Blöcke direkt
 * hochgeladen; sonst (Mobile) wird in Software zu RGBA8 dekodiert.
 */
export function ddsToTexture(
  data: Uint8Array,
  s3tcSupported: boolean,
  options: DdsTextureOptions = {},
): THREE.Texture {
  const dds = parseDds(data)
  const flip = options.flipY === true

  if (dds.format === 'BGRA8') {
    return dataTexture(bgraToRgba(dds.mips[0]!.data), dds, flip)
  }

  if (!s3tcSupported || flip) {
    return dataTexture(decodeDxt(dds.mips[0]!.data, dds.width, dds.height, dds.format), dds, flip)
  }

  const format =
    dds.format === 'DXT1'
      ? THREE.RGBA_S3TC_DXT1_Format
      : dds.format === 'DXT3'
        ? THREE.RGBA_S3TC_DXT3_Format
        : THREE.RGBA_S3TC_DXT5_Format

  const mipmaps = dds.mips.map((m) => ({
    data: m.data,
    width: m.width,
    height: m.height,
  }))

  const tex = new THREE.CompressedTexture(
    mipmaps as unknown as ImageData[],
    dds.width,
    dds.height,
    format,
  )
  tex.minFilter = mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

/**
 * DDS cubemap -> three.js cube texture. Backs the mesh.fx environmentSampler
 * (Moho::MeshEnvironment, default '/textures/environment/defaultenvcube.dds',
 * Cfile:1189598; the map's envCubes list fills the name lookup and '<default>'
 * is the active entry, Cfile:1342343ff). Face order comes straight from the
 * DDS (+X,-X,+Y,-Y,+Z,-Z).
 */
export function ddsToCubeTexture(data: Uint8Array, s3tcSupported: boolean): THREE.Texture {
  const dds = parseDds(data)
  if (!dds.cubeFaces) throw new Error('DDS: not a cubemap')

  if (s3tcSupported && dds.format !== 'BGRA8') {
    const format =
      dds.format === 'DXT1'
        ? THREE.RGBA_S3TC_DXT1_Format
        : dds.format === 'DXT3'
          ? THREE.RGBA_S3TC_DXT3_Format
          : THREE.RGBA_S3TC_DXT5_Format
    const images = dds.cubeFaces.map((chain) => ({
      mipmaps: chain.map((m) => ({ data: m.data, width: m.width, height: m.height })),
      width: dds.width,
      height: dds.height,
    }))
    const tex = new THREE.CompressedCubeTexture(
      images as unknown as ConstructorParameters<typeof THREE.CompressedCubeTexture>[0],
      format,
    )
    tex.minFilter =
      dds.cubeFaces[0]!.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.needsUpdate = true
    return tex
  }

  // Software path (mobile / uncompressed): decode mip 0 of each face to RGBA.
  const faces = dds.cubeFaces.map((chain) => {
    const m = chain[0]!
    const rgba =
      dds.format === 'BGRA8'
        ? bgraToRgba(m.data)
        : decodeDxt(m.data, m.width, m.height, dds.format)
    const face = new THREE.DataTexture(new Uint8Array(rgba), m.width, m.height, THREE.RGBAFormat)
    face.needsUpdate = true
    return face
  })
  const tex = new THREE.CubeTexture(faces)
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

function dataTexture(rgba: Uint8Array, dds: DdsImage, flipY: boolean): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array(rgba), dds.width, dds.height, THREE.RGBAFormat)
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 4
  // Default false — identical behavior to CompressedTexture, which
  // DirectX UVs of the game data then fit without flipping.
  tex.flipY = flipY
  tex.needsUpdate = true
  return tex
}
