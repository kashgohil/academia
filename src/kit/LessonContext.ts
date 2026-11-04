import { createContext, useContext } from "react";

export const LessonContext = createContext<{ path: string }>({ path: "" });
export const useLesson = () => useContext(LessonContext);
