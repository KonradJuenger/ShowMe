import { app, session } from "electron";
import { mayAccessLocalFonts } from "./main";
let permissionsInstalled = false;
app.on("browser-window-created", () => {
  if (permissionsInstalled) return;
  permissionsInstalled = true;
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission) =>
      permission === "local-fonts" && mayAccessLocalFonts(webContents),
  );
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) =>
      callback(
        permission === "local-fonts" && mayAccessLocalFonts(webContents),
      ),
  );
});
