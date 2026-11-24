import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";
import { Shell } from "./components/Shell";
import { KeeperPage } from "./pages/Keeper";
import { LeaderboardPage } from "./pages/Leaderboard";
import { StatsPage } from "./pages/Stats";
import { TasksPage } from "./pages/Tasks";
import { RegisterTaskPage } from "./pages/RegisterTask";

const router = createBrowserRouter([{ path: "/", element: <Shell />, children: [
  { index: true, element: <Navigate to="/tasks" replace /> },
  { path: "tasks", element: <TasksPage /> },
  { path: "keepers", element: <LeaderboardPage /> },
  { path: "keepers/:keeper", element: <KeeperPage /> },
  { path: "stats", element: <StatsPage /> },
  { path: "register", element: <RegisterTaskPage /> },
]}]);

export function App() { return <RouterProvider router={router} />; }
