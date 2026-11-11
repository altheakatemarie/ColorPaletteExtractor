
(function (global) {
  "use strict";

  // Convert RGB values to HEX.
  function hexOf(rgb) {
    return "#" + rgb
      .map(v => v.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }

  // Build the final palette with HEX, RGB, and percentages.
  function makePalette(groups, total) {
    return [...groups.values()]
      .filter(group => group.count > 0)
      .map(group => {
        const rgb = group.rgb || [
          Math.round(group.r / group.count),
          Math.round(group.g / group.count),
          Math.round(group.b / group.count)
        ];

        return {
          hex: hexOf(rgb),
          rgb,
          percentage:
            Math.round((group.count / total) * 10000) / 100,
          frequency: group.count
        };
      })
      .sort((a, b) =>
        b.frequency - a.frequency ||
        a.hex.localeCompare(b.hex)
      )
      .map(({ hex, rgb, percentage }) => ({
        hex,
        rgb,
        percentage
      }));
  }

  // Extract All: find shade groups without a 10-color limit.
  function autoGroups(pixels) {
    const bins = new Map();

    for (let i = 0; i < pixels.length; i += 3) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];

      const key =
        ((r >> 5) << 6) |
        ((g >> 5) << 3) |
        (b >> 5);

      let bin = bins.get(key);

      if (!bin) {
        bin = { r: 0, g: 0, b: 0, count: 0 };
        bins.set(key, bin);
      }

      bin.r += r;
      bin.g += g;
      bin.b += b;
      bin.count++;
    }

    const groups = new Map();

    for (const bin of bins.values()) {
      const rgb = [
        Math.round(bin.r / bin.count),
        Math.round(bin.g / bin.count),
        Math.round(bin.b / bin.count)
      ];

      const key = rgb.join(",");
      let group = groups.get(key);

      if (!group) {
        group = { rgb, count: 0 };
        groups.set(key, group);
      }

      group.count += bin.count;
    }

    return makePalette(groups, pixels.length / 3);
  }

  // Extract a selected number of main colors (1–10).
  // Uses weighted median-cut color quantization.
  function mainColorGroups(pixels, wanted) {
    const histogram = new Map();

    for (let i = 0; i < pixels.length; i += 3) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];

      const key =
        ((r >> 3) << 10) |
        ((g >> 3) << 5) |
        (b >> 3);

      let item = histogram.get(key);

      if (!item) {
        item = {
          r: 0,
          g: 0,
          b: 0,
          count: 0,
          key
        };

        histogram.set(key, item);
      }

      item.r += r;
      item.g += g;
      item.b += b;
      item.count++;
    }

    const entries = [...histogram.values()].map(item => ({
      rgb: [
        item.r / item.count,
        item.g / item.count,
        item.b / item.count
      ],
      count: item.count,
      key: item.key
    }));

    function describe(items) {
      const mins = [255, 255, 255];
      const maxs = [0, 0, 0];
      let count = 0;

      for (const item of items) {
        count += item.count;

        for (let c = 0; c < 3; c++) {
          mins[c] = Math.min(mins[c], item.rgb[c]);
          maxs[c] = Math.max(maxs[c], item.rgb[c]);
        }
      }

      const ranges = maxs.map(
        (value, c) => value - mins[c]
      );

      const axis = ranges.indexOf(
        Math.max(...ranges)
      );

      return {
        items,
        count,
        axis,
        range: ranges[axis]
      };
    }

    const boxes = [describe(entries)];

    while (boxes.length < wanted) {
      let index = -1;
      let score = -1;

      boxes.forEach((box, i) => {
        if (
          box.items.length < 2 ||
          box.range <= 0
        ) {
          return;
        }

        const s = box.range * box.count;

        if (s > score) {
          score = s;
          index = i;
        }
      });

      if (index < 0) {
        break;
      }

      const box = boxes.splice(index, 1)[0];

      box.items.sort((a, b) =>
        a.rgb[box.axis] - b.rgb[box.axis] ||
        a.key - b.key
      );

      const mid = box.count / 2;

      let sum = 0;
      let split = 1;

      for (
        let i = 0;
        i < box.items.length - 1;
        i++
      ) {
        sum += box.items[i].count;

        if (sum >= mid) {
          split = i + 1;
          break;
        }
      }

      boxes.push(
        describe(box.items.slice(0, split)),
        describe(box.items.slice(split))
      );
    }

    const groups = new Map();

    for (const box of boxes) {
      let r = 0;
      let g = 0;
      let b = 0;

      for (const item of box.items) {
        r += item.rgb[0] * item.count;
        g += item.rgb[1] * item.count;
        b += item.rgb[2] * item.count;
      }

      const rgb = [r, g, b].map(
        value => Math.round(value / box.count)
      );

      const key = rgb.join(",");
      const previous = groups.get(key);

      if (previous) {
        previous.count += box.count;
      } else {
        groups.set(key, {
          rgb,
          count: box.count
        });
      }
    }

    return makePalette(
      groups,
      pixels.length / 3
    );
  }

  // Main extraction function.
  async function extractInBrowser(file, mode) {
    if (
      !["image/jpeg", "image/png"].includes(file.type)
    ) {
      throw new Error(
        "Only JPG and PNG images are supported."
      );
    }

    if (file.size >= 8 * 1024 * 1024) {
      throw new Error(
        "Upload an image smaller than 8 MB."
      );
    }

    if (
      mode !== "auto" &&
      (
        !/^\d+$/.test(mode) ||
        +mode < 1 ||
        +mode > 10
      )
    ) {
      throw new Error(
        "Choose Auto Extraction or 1–10 colors."
      );
    }

    let bitmap;

    try {
      bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image"
      });
    } catch {
      throw new Error(
        "Invalid or damaged image. Try another JPG or PNG."
      );
    }

    try {
      if (
        bitmap.width * bitmap.height > 20000000
      ) {
        throw new Error(
          "Use an image at or below 20 megapixels."
        );
      }

      const scale = Math.min(
        1,
        300 / bitmap.width,
        300 / bitmap.height
      );

      const canvas = document.createElement("canvas");

      canvas.width = Math.max(
        1,
        Math.round(bitmap.width * scale)
      );

      canvas.height = Math.max(
        1,
        Math.round(bitmap.height * scale)
      );

      const ctx = canvas.getContext("2d", {
        willReadFrequently: true
      });

      if (!ctx) {
        throw new Error(
          "Your browser does not support image extraction."
        );
      }

      ctx.drawImage(
        bitmap,
        0,
        0,
        canvas.width,
        canvas.height
      );

      const data = ctx.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      ).data;

      const pixels = [];

      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];

        if (alpha === 0) {
          continue;
        }

        for (let channel = 0; channel < 3; channel++) {
          pixels.push(
            Math.round(
              (
                data[i + channel] * alpha +
                255 * (255 - alpha)
              ) / 255
            )
          );
        }
      }

      if (!pixels.length) {
        throw new Error(
          "This image is completely transparent."
        );
      }

      if (mode === "auto") {
        return autoGroups(pixels);
      }

      return mainColorGroups(
        pixels,
        Number(mode)
      );

    } finally {
      bitmap.close();
    }
  }

  // Make the processing function available to index.html.
  global.PaletteEngine = Object.freeze({
    extractInBrowser
  });

})(window);
