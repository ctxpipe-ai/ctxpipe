# Vision eval fixtures

These are the diagrams of the vision eval (`../../vision.ts`). Each fixture has three files:

- the source of the diagram (`.dot`, `.d2`, `.puml` or `.mmd`);
- the image that the model reads (`.png`, or `.jpg` for the photo);
- the gold graph (`.gold.json`), which we wrote by hand from the source.

All the diagrams are made up. They contain no customer data. Four tools drew them, so the eval sees more than one style:

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
| `checkout` | sequence | Mermaid, with a self-message and an async message |
| `cdn-cache` | sequence | D2 |

## Draw the images again

Run these commands from this folder with Docker. On an x86 host, use the `linux-amd64` archive of D2. A change of a source also needs a change of its gold graph.

```sh
docker run --rm -v "$PWD:/f" -w /f alpine:3.22 sh -c '
  apk add -q graphviz font-dejavu imagemagick rsvg-convert curl &&
  curl -sSfL https://github.com/d2lang/d2/releases/download/v0.9.0/d2-v0.9.0-linux-arm64.tar.gz | tar xz -C /tmp &&
  D2=$(find /tmp -name d2 -type f -perm -u+x | head -1) &&
  for f in arch-web data-platform deploy-flow order-states; do dot -Gdpi=150 -Tpng $f.dot -o $f.png; done &&
  $D2 --sketch --pad 40 arch-microservices.d2 /tmp/a.svg && rsvg-convert -z 1.5 -b white /tmp/a.svg -o arch-microservices.png &&
  $D2 --sketch --pad 40 incident.d2 /tmp/i.svg && rsvg-convert -z 1.5 -b white /tmp/i.svg -o incident.png &&
  $D2 --pad 40 cdn-cache.d2 /tmp/c.svg && rsvg-convert -z 1.5 -b white /tmp/c.svg -o cdn-cache.png &&
  magick arch-web.png -resize 70% -background "#d9d4c7" -rotate 2.5 -attenuate 0.6 +noise Gaussian -blur 0x0.6 -modulate 95,80 -quality 45 arch-web-photo.jpg'
docker run --rm -v "$PWD:/data" plantuml/plantuml -tpng /data/arch-components.puml /data/oauth-login.puml
docker run --rm -u root -v "$PWD:/data" minlag/mermaid-cli -i /data/checkout.mmd -o /data/checkout.png -s 2 -b white
docker run --rm -u root -v "$PWD:/data" minlag/mermaid-cli -i /data/ci-pipeline.mmd -o /data/ci-pipeline.png -s 2 -b white
```

The noise of the photo is random, so a new `arch-web-photo.jpg` has other bytes.
