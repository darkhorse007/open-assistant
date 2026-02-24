import "solid-js"

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": any
    }
  }
}
