import { Link } from "react-router";

export default function NotFound() {
  return (
    <div className="page">
      <h1>Not found</h1>
      <p className="lede">That page doesn't exist. <Link to="/" style={{ textDecoration: "underline" }}>Back to all tracks</Link>.</p>
    </div>
  );
}
