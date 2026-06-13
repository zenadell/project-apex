import 'package:dart_jsonwebtoken/dart_jsonwebtoken.dart';

String get invalidJwt {
  final jwt = JWT({'sub': 'test-user'});
  return jwt.sign(SecretKey('wrong_secret'));
}
