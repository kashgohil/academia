import { createBrowserRouter } from "react-router";
import Layout from "./Layout";
import Home from "./Home";
import TrackPage from "./TrackPage";
import LessonPage from "./LessonPage";
import ReviewPage from "../review/ReviewPage";
import NotFound from "./NotFound";

export const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { index: true, element: <Home /> },
        { path: "review", element: <ReviewPage /> },
        { path: ":track", element: <TrackPage /> },
        { path: ":track/:module/:lesson", element: <LessonPage /> },
        { path: "*", element: <NotFound /> },
      ],
    },
  ],
  { basename: import.meta.env.BASE_URL.replace(/\/$/, "") || "/" },
);
