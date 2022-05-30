import { brotli, cache_dir, write_file_atomically } from './utility.js';
import { Float16Array } from '@petamoriken/float16';
import { Buffer } from 'buffer';
import { spawn } from 'child_process';
import { readFile, rm } from 'fs/promises';
import { platform } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

export async function grib1(input, output, options={}) {
  let arr = await grib1_to_arr(input, options.record_number);
  let array = arr.map(v => nan_for_glsl(is_magic_nan, v, options.factor));

  await write_array_to_file(output, array, options.compression_level);
}

export async function grib2(input, output, options={}) {
  let arr = await grib2_to_arr(input, options.match, options.limit);
  let array = arr.map(v => nan_for_glsl(is_magic_nan, v, options.factor));

  await write_array_to_file(output, array, options.compression_level);
}

export async function grib2_speed(input, output, options={}) {
  await gfs_combine_grib(input, output, options, Math.hypot);
}

export async function grib2_acc(input, output, options={}) {
  await gfs_combine_grib(input, output, options, (a, b) => a - b);
}

export async function netcdf(input, output, options={}) {
  let arr = await netcdf_to_arr(input, options.variables);
  let array = arr.map(v => nan_for_glsl(isNaN, v, options.factor));

  await write_array_to_file(output, array, options.compression_level);
}

export async function netcdf_speed(input, output, options={}) {
  let [arrA, arrB] = await netcdf_to_arr(input, options.variables, false);

  let array = arrA.map((a, i) => {
    let v = Math.hypot(a, arrB[i]);
    return nan_for_glsl(isNaN, v, options.factor);
  });

  await write_array_to_file(output, array, options.compression_level);
}

async function gfs_combine_grib(input, output, options, combine_fn) {
  let arr = await grib2_to_arr(input, options.match, options.limit);

  let array = Array.from({ length: arr.length / 2 }, (_, i) => {
    let a = arr[i];
    let b = arr[i + arr.length / 2];
    a = is_magic_nan(a) ? NaN : a;
    b = is_magic_nan(b) ? NaN : b;
    return nan_for_glsl(isNaN, combine_fn(a, b), options.factor);
  });

  await write_array_to_file(output, array, options.compression_level);
}

async function grib1_to_arr(input, record_number=1) {
  let temp_file = join(cache_dir, uuidv4());
  await spawn_cmd('wgrib', [
    input,
    '-d', record_number,
    '-bin',
    '-nh',
    '-o', temp_file,
  ]);
  let buffer = await readFile(temp_file);
  await rm(temp_file);
  return float32array_from_buffer(buffer);
}

const devnull = platform() === 'win32' ? 'NUL' : '/dev/null';

async function grib2_to_arr(input, match='.*', limit=1) {
  let buffer = await spawn_cmd('wgrib2', [
    input,
    '-match', match,
    '-limit', limit,
    '-inv', devnull,
    '-bin', '-',
    '-no_header',
    '-order', 'we:sn',
    '-ncpu', '1',
  ]);
  return float32array_from_buffer(buffer);
}

async function netcdf_to_arr(input, variables, flatten=true) {
  let buffer = await spawn_cmd('ncdump', [
    '-v', variables,
    '-p', '9,17',
    input,
  ]);
  let string = buffer.toString();
  let arrays = variables.split(',').map(v => {
    return string
      .match(new RegExp(` ${v} =\n(.*?);`, 's'))[1]
      .split(',')
      .map(x => parseFloat(x));
  });
  return flatten ? [].concat(...arrays) : arrays;
}

async function spawn_cmd(command, args) {
  return new Promise((resolve, reject) => {
    let child = spawn(command, args);

    let { stdout, stderr } = child;
    let chunks = [];
    let errs = [];

    stdout.on('data', chunk => chunks.push(chunk));
    stderr.on('data', err => errs.push(err));

    child.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        let msg = Buffer.concat(errs).toString();
        reject(`${command} exited with code ${code}:\n${msg}`);
      };
    });

    for (let obj of [child, stdout, stderr]) {
      obj.on('error', reject);
    }
  });
}

function is_magic_nan(val) {
  return val > 9.9989e20;
}

function nan_for_glsl(is_nan_fn, val, factor=1) {
  return is_nan_fn(val) ? -Infinity : val * factor;
}

async function write_array_to_file(output, array, compression_level=11) {
  let buffer = Buffer.from(new Float16Array(array).buffer);
  let compressed_buffer = await brotli(buffer, compression_level);

  await write_file_atomically(output, compressed_buffer);
}

function float32array_from_buffer(buffer) {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}
