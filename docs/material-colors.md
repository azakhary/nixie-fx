# Material color version 1

New graph materials use `colorVersion: 1`. Materials without this field keep the legacy shaders and appearance. The effect file version stays at 1.

The new mode converts particle colors, color parameters, color constants, and gradient stops from sRGB to linear before graph math. It applies particle color once. It encodes the result for the output target and multiplies RGB by final alpha only for a premultiplied blend. Three uses its standard output conversion. Pixi uses sRGB output with the premultiplied blend required by its particle container. Material previews use sRGB output.

Texture Sample stores `auto`, `srgb`, or `linear` in `samplerType`. Auto decodes when an RGB or RGBA output is used. Single-channel masks remain raw. The historical `Color` value means Auto. Legacy mode ignores sampler choices.

The editor exposes Legacy colors below Blend. Turn it off to opt in. Turn it on to restore legacy rendering. Saving an old material without this change does not opt in.

Older nixie-fx versions ignore `colorVersion` and render every material with legacy colors, including materials saved in the new mode. Update the runtime in each game before relying on the new colors.

Versioned graphs use the GPU graph path so the legacy CPU bake cannot bypass color conversion. Legacy shader source is protected by full-source hash tests for Three particles, Three trails, Pixi particles, and material previews.

This branch includes the existing task #2214 runtime commits because current editor main requires their particle-light APIs. No bloom pass, tonemapping, or editor drawing path changes are part of this fix.
