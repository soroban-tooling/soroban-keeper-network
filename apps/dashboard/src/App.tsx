import { Navigate, RouterProvider, createBrowserRouter } from "react-router-dom";
import { Shell } from "./components/Shell";
import { AdminPage } from "./pages/Admin";
import { KeeperPage } from "./pages/Keeper";
import { LeaderboardPage } from "./pages/Leaderboard";
import { OwnerPage } from "./pages/Owner";
import { RegisterTaskPage } from "./pages/RegisterTask";
import { StatsPage } from "./pages/Stats";
import { TaskDetailPage } from "./pages/TaskDetail";
import { TasksPage } from "./pages/Tasks";
import { TreasuryPage } from "./pages/Treasury";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Shell />,
    children: [
      { index: true, element: <Navigate to="/tasks" replace /> },
      { path: "tasks", element: <TasksPage /> },
      { path: "tasks/:taskId", element: <TaskDetailPage /> },
      { path: "keepers", element: <LeaderboardPage /> },
      { path: "keepers/:keeper", element: <KeeperPage /> },
      { path: "owners/:owner", element: <OwnerPage /> },
      { path: "stats", element: <StatsPage /> },
      { path: "treasury", element: <TreasuryPage /> },
      { path: "admin", element: <AdminPage /> },
      { path: "register", element: <RegisterTaskPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
