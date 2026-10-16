/**
 * The CameraShot logo: a camera seen from above with its field of view, its dashed focus area and a red live dot
 * (the same picture the app draws on the stage), next to the name.
 * The artwork is client/public/logo.svg, so the browser tab icon and this page share one file.
 */
export default function Logo({ size = 72, tagline = true }: { size?: number; tagline?: boolean }) {
  return (
    <div className="logo-lockup">
      <img src={`${import.meta.env.BASE_URL}logo.svg`} width={size} height={size} alt="" />
      <div>
        <div className="logo-word">Camera<b>Shot</b></div>
        {tagline && <div className="logo-tag">Stage and camera plans for live production</div>}
      </div>
    </div>
  )
}
