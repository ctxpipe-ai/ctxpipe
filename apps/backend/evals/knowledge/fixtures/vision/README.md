# Vision eval fixtures

These are the diagrams of the vision eval (`../../vision.ts`). Each fixture has three files:

- the source of the diagram (`.dot`, `.d2`, `.puml` or `.mmd`);
- the image that the model reads (`.png`, or `.jpg` for the photo);
- the gold graph (`.gold.json`), which we wrote by hand from the source.

`arch-web-photo.gold.json` is a copy of `arch-web.gold.json` on purpose: each fixture is one image and one gold graph. Change the two files together.

All the diagrams are made up. They contain no customer data. Four tools drew them, so the eval sees more than one style. The last five are the hard set: dense, photographed, small, in lanes, or in a notation with much text.

| Fixture | Category | Tool |
| --- | --- | --- |
| `arch-web` | architecture | Graphviz, nested clusters |
| `arch-web-photo` | architecture | `arch-web`, made to look like a photo of a screen (turned, noise, blur, JPEG) |
| `arch-microservices` | architecture | D2, hand-drawn sketch style, nested containers |
| `arch-components` | architecture | PlantUML component diagram with packages |
| `data-platform` | architecture | Graphviz, 14 nodes and 18 edges that cross |
| `deploy-flow` | flow | Graphviz flowchart with decisions |
| `ci-pipeline` | flow | Mermaid flowchart with subgraphs |
| `incident` | flow | D2, hand-drawn sketch style, with a loop |
| `order-states` | flow | Graphviz state machine |
| `oauth-login` | sequence | PlantUML |
| `checkout` | sequence | Mermaid, with a self-message |
| `cdn-cache` | sequence | D2 |
| `dense-mesh` | architecture | Graphviz `neato`: 32 nodes and 48 edges with many crossings, no main direction (`"direction": null`) |
| `whiteboard-photo` | architecture | D2 sketch with the Kalam handwriting font (SIL Open Font License), made to look like a photo of a whiteboard (gray, perspective, uneven light, noise, blur, JPEG). It is synthetic: the letters are a font, not real handwriting. |
| `lowres-screenshot` | flow | Mermaid flowchart, made small (245 × 716 pixels) with strong JPEG loss |
| `swimlanes` | flow | D2 grid with three lanes; lines cross lanes and labels |
| `c4-container` | architecture | C4-PlantUML container diagram: each box holds a name, a type and a description |

## Draw the images again

Run these commands from this folder with Docker. On an x86 host, use the `linux-amd64` archive of D2. A change of a source also needs a change of its gold graph.

```sh
docker run --rm -v "$PWD:/f" -w /f alpine:3.22 sh -c '
  apk add -q graphviz font-dejavu imagemagick imagemagick-jpeg rsvg-convert curl &&
  curl -sSfL https://github.com/d2lang/d2/releases/download/v0.9.0/d2-v0.9.0-linux-arm64.tar.gz | tar xz -C /tmp &&
  D2=$(find /tmp -name d2 -type f -perm -u+x | head -1) &&
  for f in arch-web data-platform deploy-flow order-states; do dot -Gdpi=150 -Tpng $f.dot -o $f.png; done &&
  dot -Gdpi=130 -Tpng dense-mesh.dot -o dense-mesh.png &&
  $D2 --pad 40 swimlanes.d2 /tmp/s.svg && rsvg-convert -z 1.4 -b white /tmp/s.svg -o swimlanes.png &&
  K=https://github.com/google/fonts/raw/main/ofl/kalam && curl -sSfL -o /tmp/kr.ttf $K/Kalam-Regular.ttf && curl -sSfL -o /tmp/kb.ttf $K/Kalam-Bold.ttf &&
  $D2 --sketch --pad 60 --font-regular /tmp/kr.ttf --font-bold /tmp/kb.ttf --font-italic /tmp/kr.ttf --font-semibold /tmp/kb.ttf whiteboard.d2 /tmp/w.svg && rsvg-convert -z 1.3 -b white /tmp/w.svg -o /tmp/w.png &&
  W=$(magick identify -format %w /tmp/w.png) && H=$(magick identify -format %h /tmp/w.png) &&
  magick /tmp/w.png -colorspace Gray -level 0%,100%,0.8 -background "#c9c6bd" -virtual-pixel background -distort Perspective "0,0 $((W/30)),$((H/12))  $W,0 $((W-W/20)),0  0,$H 0,$((H-H/25))  $W,$H $W,$((H-H/10))" \( -size ${W}x${H} radial-gradient:"#ffffff"-"#8f8a80" \) -compose multiply -composite -attenuate 0.5 +noise Gaussian -blur 0x0.8 -resize 75% -quality 50 whiteboard-photo.jpg &&
  $D2 --sketch --pad 40 arch-microservices.d2 /tmp/a.svg && rsvg-convert -z 1.5 -b white /tmp/a.svg -o arch-microservices.png &&
  $D2 --sketch --pad 40 incident.d2 /tmp/i.svg && rsvg-convert -z 1.5 -b white /tmp/i.svg -o incident.png &&
  $D2 --pad 40 cdn-cache.d2 /tmp/c.svg && rsvg-convert -z 1.5 -b white /tmp/c.svg -o cdn-cache.png &&
  magick arch-web.png -resize 70% -background "#d9d4c7" -rotate 2.5 -attenuate 0.6 +noise Gaussian -blur 0x0.6 -modulate 95,80 -quality 45 arch-web-photo.jpg'
docker run --rm -v "$PWD:/data" plantuml/plantuml -tpng /data/arch-components.puml /data/oauth-login.puml /data/c4-container.puml
docker run --rm -u root -v "$PWD:/data" minlag/mermaid-cli -i /data/checkout.mmd -o /data/checkout.png -s 2 -b white
docker run --rm -u root -v "$PWD:/data" minlag/mermaid-cli -i /data/ci-pipeline.mmd -o /data/ci-pipeline.png -s 2 -b white
docker run --rm -u root -v "$PWD:/data" minlag/mermaid-cli -i /data/lowres-screenshot.mmd -o /data/lowres-full.png -s 1 -b white
docker run --rm -v "$PWD:/f" -w /f alpine:3.22 sh -c 'apk add -q imagemagick imagemagick-jpeg && magick lowres-full.png -resize 60% -quality 30 lowres-screenshot.jpg && rm lowres-full.png'
```

The noise of the photos is random, so a new `arch-web-photo.jpg` or `whiteboard-photo.jpg` has other bytes.
