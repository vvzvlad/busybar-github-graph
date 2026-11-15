# GitHub Graph

Your GitHub contribution graph on the BUSY Bar's LED screen.

A JavaScript app for [BUSY Bar](https://busy.app). Work in progress.

## What it does

- The front display shows 72 weeks as 72 columns of seven days, one pixel per day, in GitHub's shades of green. Today blinks until your first contribution.
- The wheel switches between the graph and your current streak in large digits.
- The back display shows your total for the year, your current streak and your best day.
- Without a connection the last graph stays, dimmed, with a red cross in the corner.
- Settings: login, token, color scheme: GitHub green, Halloween orange, winter blue or purple.

## Data

The GitHub GraphQL API with your personal access token, which stays in the app's settings on your BUSY Bar.

## Build

Node 24 and npm:

```sh
npm ci
npm run build         # dist/io.github.vvzvlad.ghgraph.tgz
npm run app:install   # install it on a BUSY Bar connected over USB
npm run app:run       # start it
```

## License

[MIT](LICENSE)
