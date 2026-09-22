package app.worklog.hours;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;

/**
 * Hands a downloaded APK to the system installer, so an update can be applied
 * without leaving the app.
 *
 * The app is distributed as a direct APK rather than through the Play Store,
 * so there is no in-app update API to use instead. What there is, is an
 * ACTION_VIEW intent on a content:// URI — the file cannot be handed over as
 * a file:// path, which Android has refused to accept across app boundaries
 * since Nougat. The URI comes from the FileProvider already declared in the
 * manifest, whose cache-path entry covers the directory the download lands
 * in.
 *
 * Installing still needs the user's blessing twice: once for the app to be
 * allowed to install packages at all (a per-app system setting since Oreo,
 * which canInstall/openInstallSettings exist to surface rather than hit as a
 * silent failure), and once for the install itself.
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    /** Whether this app is currently allowed to install packages. */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject result = new JSObject();
        boolean granted =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            getContext().getPackageManager().canRequestPackageInstalls();
        result.put("granted", granted);
        call.resolve(result);
    }

    /** Opens the system page where that permission is granted. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            call.resolve();
            return;
        }
        try {
            Intent intent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not open the install-permission settings: " + e.getMessage(), e);
        }
    }

    /** Opens the system installer for an APK already on disk. */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("no path given");
            return;
        }
        // Filesystem returns a file:// URI; FileProvider wants a plain path.
        if (path.startsWith("file://")) {
            path = Uri.parse(path).getPath();
        }
        File apk = new File(path);
        if (!apk.exists()) {
            call.reject("no file at " + path);
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            // The installer is a different app, so it needs read access to the
            // URI granted explicitly for the life of the intent.
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("could not start the installer: " + e.getMessage(), e);
        }
    }
}
