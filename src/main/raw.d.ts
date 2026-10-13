/** A file imported as text (`./file?raw`): Vite puts its contents in the bundle. */
declare module '*?raw' {
  const text: string;
  export default text;
}
