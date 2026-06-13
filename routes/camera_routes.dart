import 'package:shelf_router/shelf_router.dart';
import '../controllers/camera_controller.dart';

Router cameraRouter(CameraController controller) {
  final router = Router();
  router.post('/api/capture', controller.capture);
  return router;
}
