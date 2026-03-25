from django.urls import path
from .views import ChatView, UploadView, AnalyzeView

urlpatterns = [
    path("chat/", ChatView.as_view(), name="chat"),
    path("upload/", UploadView.as_view(), name="upload"),
    path("analyze/", AnalyzeView.as_view(), name="analyze"),
]
