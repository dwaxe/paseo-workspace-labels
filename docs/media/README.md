# Demo media

These images show the production `LabelsPanel`, rendered with Paseo 0.11.1's
React 19 and React Native Web components in headless Chrome. The light theme,
settings, and Paseo API use isolated demo fixtures. No live workspace, account,
or conversation data appears in the images.

The setup starts with a workspace titled `alpha` at `/checkouts/ds-alpha` and a
conversation titled `Improve search`. The capture enters the checkout label
`alpha` and clicks the real **Enable automatic naming** button. The production
server runtime saves one demo enrollment and produces `Improve search · alpha`.

To recreate the capture:

1. Compile the current client and server entries with Paseo's plugin compiler.
2. Render the contributed workspace panel using the host's React components,
   empty settings, and the demo metadata above. Give the server runtime a
   temporary state directory and a fake Paseo API.
3. At an 880 × 680 viewport and 2× pixel density, enter `alpha` and capture the
   panel before and after clicking Enable. Crop both images to the same
   840 × 640 panel area. Also check the full controls at a 390px viewport.
4. Combine the two PNGs into a seven-second looping GIF:

```sh
convert -delay 300 docs/media/workspace-names-setup.png \
  -delay 400 docs/media/workspace-names-enabled.png \
  -resize 840x640 +dither -colors 256 -loop 0 -layers Optimize \
  docs/media/workspace-names.gif
```
