(function (global) {
  'use strict';

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8Bytes(str) {
    return new TextEncoder().encode(str);
  }

  function dosDateTime(date) {
    var d = date || new Date();
    var year = Math.max(d.getFullYear() - 1980, 0);
    var month = d.getMonth() + 1;
    var day = d.getDate();
    var hours = d.getHours();
    var minutes = d.getMinutes();
    var seconds = Math.floor(d.getSeconds() / 2);
    var time = (hours << 11) | (minutes << 5) | seconds;
    var dayPart = (year << 9) | (month << 5) | day;
    return { time: time, date: dayPart };
  }

  function u16(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff); }
  function u32(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }

  function ZipWriter() {
    this.entries = [];
  }

  ZipWriter.prototype.add = function (name, content) {
    var nameBytes = utf8Bytes(name);
    var data;
    if (content instanceof Uint8Array) {
      data = content;
    } else if (content instanceof ArrayBuffer) {
      data = new Uint8Array(content);
    } else {
      data = utf8Bytes(String(content));
    }
    this.entries.push({ name: nameBytes, data: data, time: dosDateTime() });
  };

  ZipWriter.prototype.build = function () {
    var localParts = [];
    var centralParts = [];
    var offset = 0;

    for (var i = 0; i < this.entries.length; i++) {
      var entry = this.entries[i];
      var crc = crc32(entry.data);
      var size = entry.data.length;

      var local = [];
      u32(local, 0x04034b50);
      u16(local, 20);
      u16(local, 0x0800);
      u16(local, 0);
      u16(local, entry.time.time);
      u16(local, entry.time.date);
      u32(local, crc);
      u32(local, size);
      u32(local, size);
      u16(local, entry.name.length);
      u16(local, 0);

      localParts.push(new Uint8Array(local), entry.nameBytes || entry.name, entry.data);

      var central = [];
      u32(central, 0x02014b50);
      u16(central, 20);
      u16(central, 20);
      u16(central, 0x0800);
      u16(central, 0);
      u16(central, entry.time.time);
      u16(central, entry.time.date);
      u32(central, crc);
      u32(central, size);
      u32(central, size);
      u16(central, entry.name.length);
      u16(central, 0);
      u16(central, 0);
      u16(central, 0);
      u16(central, 0);
      u32(central, 0);
      u32(central, offset);

      centralParts.push(new Uint8Array(central), entry.name);
      offset += local.length + entry.name.length + size;
    }

    var centralSize = 0;
    for (var j = 0; j < centralParts.length; j++) centralSize += centralParts[j].length;

    var end = [];
    u32(end, 0x06054b50);
    u16(end, 0);
    u16(end, 0);
    u16(end, this.entries.length);
    u16(end, this.entries.length);
    u32(end, centralSize);
    u32(end, offset);
    u16(end, 0);

    var chunks = localParts.concat(centralParts, [new Uint8Array(end)]);
    var total = 0;
    for (var k = 0; k < chunks.length; k++) total += chunks[k].length;

    var out = new Uint8Array(total);
    var pos = 0;
    for (var m = 0; m < chunks.length; m++) {
      out.set(chunks[m], pos);
      pos += chunks[m].length;
    }
    return out;
  };

  function zipFiles(files, options) {
    var writer = new ZipWriter();
    var used = {};
    files.forEach(function (f) {
      var name = f.name.replace(/^\/+/, '');
      if (!name) return;
      if (used[name]) {
        var dot = name.lastIndexOf('.');
        var base = dot > 0 ? name.slice(0, dot) : name;
        var ext = dot > 0 ? name.slice(dot) : '';
        var n = 2;
        while (used[base + '-' + n + ext]) n++;
        name = base + '-' + n + ext;
      }
      used[name] = true;
      writer.add(name, f.content);
    });
    var bytes = writer.build();
    return new Blob([bytes], { type: 'application/zip' });
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  global.MonoZip = { zipFiles: zipFiles, downloadBlob: downloadBlob, ZipWriter: ZipWriter };
})(window);
